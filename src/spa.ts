import { $ } from "bun";
import { BackendCompiler, type BackendCompileResult } from "./backend-compiler";
import { collectHead } from "./head-render";
import { importFresh } from "./utils";
import type { BackendRuntimeHandler } from "./backend";

export type SpaPage = {
  route: string;
  component: React.ComponentType;
  callsite?: SourceLocation;
};

type SourceLocation = {
  file: string;
  line: number;
};

type ComponentImport =
  | { kind: "named"; imported: string; local: string; specifier: string }
  | { kind: "default"; local: string; specifier: string }
  | { kind: "local"; local: string; specifier: string };

export class SpaCompiler {
  private tmpDir: string;
  private entries: Record<string, string> = {};
  private heads: Record<string, string> = {};
  private bundleCache: Record<string, string> = {};
  private backendHandlers: BackendRuntimeHandler[] = [];
  private collectedModules = new Set<string>();

  constructor() {
    this.tmpDir = `${process.cwd()}\\.picokit`;
  }

  static getCallerLocation(): SourceLocation | undefined {
    const stack = new Error().stack;
    const callerLine = stack
      ?.split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          !line.includes("src\\main.ts") &&
          !line.includes("src/main.ts") &&
          !line.includes("src\\spa.ts") &&
          !line.includes("src/spa.ts") &&
          line.includes(":"),
      );

    const match = callerLine?.match(/\(?([A-Za-z]:[^\n:]+):(\d+):\d+\)?$/);
    if (!match || !match[1] || !match[2]) return undefined;

    return { file: match[1], line: Number(match[2]) };
  }

  // Scan phase: AST-split each page, register its backend handlers, and write the
  // client entry — but do NOT bundle. Bundling is deferred to getBundle() so the
  // dev server can build a route lazily on first request.
  async prepare(spaPages: Record<string, SpaPage>) {
    this.entries = {};
    this.heads = {};
    this.bundleCache = {};
    this.backendHandlers = [];
    this.collectedModules = new Set();

    // .nothrow(): on Windows, freshly-imported modules (the .fresh-*/static-* files)
    // stay locked for the life of the process, so rm can't delete them — that's fine,
    // they have unique names and are cleared on the next (unlocked) startup.
    await $`rm -rf ${this.tmpDir}`.quiet().nothrow();
    await $`mkdir -p ${this.tmpDir}`.quiet().nothrow();
    const backendCompiler = new BackendCompiler(this.tmpDir);

    for (const page of Object.values(spaPages)) {
      const componentImport = await this.resolveComponentImport(page);
      const backendResult = await backendCompiler.compileComponentFile(
        componentImport.specifier,
        page.route,
        componentImport.local,
      );
      await this.collectBackendHandlers(backendResult);
      const clientComponentImport = { ...componentImport, specifier: this.importPath(backendResult.clientFile) };
      const entryPath = `${this.tmpDir}\\${this.safeRouteName(page.route)}-entry.tsx`;

      await Bun.write(entryPath, this.generateEntry(page.route, clientComponentImport));
      this.entries[page.route] = entryPath;
      // Bake the route's <Head> metadata into the shell so the initial HTML carries
      // the right <title>/<meta> before the bundle hydrates it.
      this.heads[page.route] = collectHead(page.component, page.route);
    }
  }

  // Bundle a single route on demand, caching the result. Throws on build failure
  // so the dev server can surface it as an overlay. `minify` is used by the build
  // command to emit production-sized assets; the dev/lazy path leaves it off.
  async getBundle(route: string, options: { minify?: boolean } = {}): Promise<string | undefined> {
    if (this.bundleCache[route]) return this.bundleCache[route];

    const entryPath = this.entries[route];
    if (!entryPath) return undefined;

    const buildResult = await Bun.build({
      entrypoints: [entryPath],
      target: "browser",
      minify: options.minify ?? false,
    });

    if (!buildResult.success) {
      throw new Error(
        `Build failed for SPA route [${route}]: ${buildResult.logs.join("\n")}`,
      );
    }

    const output = buildResult.outputs[0];
    if (!output) {
      throw new Error(`Build produced no output for SPA route [${route}]`);
    }

    const code = await output.text();
    this.bundleCache[route] = code;
    return code;
  }

  getBackendHandlers() {
    return this.backendHandlers;
  }

  getRoutes() {
    return Object.keys(this.entries);
  }

  // The generated server-side handler modules collected during prepare(). The build
  // command bundles these into dist so backend handlers run without re-AST-splitting.
  getBackendModulePaths() {
    return [...this.collectedModules];
  }

  private async collectBackendHandlers(backendResult: BackendCompileResult) {
    // All handlers in a file share one generated module; import it once even if
    // several pages live in the same source file.
    const modulePath = backendResult.handlers[0]?.modulePath;
    if (!modulePath || this.collectedModules.has(modulePath)) return;

    this.collectedModules.add(modulePath);
    // importFresh re-evaluates edited handler bodies on a dev recompile (Bun caches
    // by path and ignores query strings, so a plain re-import would be stale).
    const backendModule = await importFresh(modulePath);
    this.backendHandlers.push(...((backendModule.handlers as BackendRuntimeHandler[]) ?? []));
  }

  generateHtmlShell(route: string): string {
    const bundleUrl = `/_pico/bundle${route === "/" ? "" : route}`;
    const head = this.heads[route];
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${head ? `${head}\n` : ""}</head>
<body>
  <div id="root"></div>
  <script type="module" src="${bundleUrl}"></script>
</body>
</html>`;
  }

  private async resolveComponentImport(page: SpaPage): Promise<ComponentImport> {
    const local = page.component.name;
    if (!local) {
      throw new Error(`SPA route [${page.route}] needs a named component.`);
    }

    const file = page.callsite?.file;
    if (!file) {
      throw new Error(`Could not locate SPA route [${page.route}] callsite.`);
    }

    const source = await Bun.file(file).text();
    const imported = this.findImportedComponent(source, local);
    if (imported) {
      return {
        ...imported,
        specifier: await this.resolveImport(file, imported.specifier),
      };
    }

    if (this.isExportedLocal(source, local)) {
      return { kind: "local", local, specifier: this.importPath(file) };
    }

    throw new Error(
      `Could not resolve component [${local}] for SPA route [${page.route}]. Export it from the route file or import it with a standard ES import.`,
    );
  }

  private findImportedComponent(source: string, local: string): ComponentImport | undefined {
    const imports = source.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g);

    for (const match of imports) {
      const clause = match[1]?.trim();
      const specifier = match[2];
      if (!clause || !specifier) continue;

      const defaultName = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/)?.[1];
      if (defaultName === local) return { kind: "default", local, specifier };

      const namedClause = clause.match(/\{([^}]+)\}/)?.[1];
      if (!namedClause) continue;

      for (const part of namedClause.split(",")) {
        const [importedName, localName = importedName] = part.trim().split(/\s+as\s+/);
        if (localName?.trim() === local && importedName?.trim()) {
          return {
            kind: "named",
            imported: importedName.trim(),
            local,
            specifier,
          };
        }
      }
    }
  }

  private isExportedLocal(source: string, local: string) {
    const declaration = new RegExp(`export\\s+(?:const|function)\\s+${local}\\b`);
    const list = new RegExp(`export\\s*\\{[^}]*\\b${local}\\b[^}]*\\}`);
    return declaration.test(source) || list.test(source);
  }

  private generateEntry(route: string, componentImport: ComponentImport) {
    const componentImportLine =
      componentImport.kind === "default"
        ? `import Component from "${componentImport.specifier}";`
        : componentImport.kind === "named"
          ? `import { ${componentImport.imported} as Component } from "${componentImport.specifier}";`
          : `import { ${componentImport.local} as Component } from "${componentImport.specifier}";`;

    return `import React from "react";
import { createRoot } from "react-dom/client";
import { RouteContext, matchRoute } from "../src/router";
${componentImportLine}

const container = document.getElementById("root");
const route = ${JSON.stringify(this.normalizeRoute(route))};
const pathname = window.location.pathname;
const params = matchRoute(route, pathname) || {};
const routeState = {
  pathname,
  params,
  search: new URLSearchParams(window.location.search),
  navigate: (to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
  back: () => window.history.back(),
};

if (container) {
  // Drop the server-baked head tags so React's <Head> becomes the sole owner of
  // the head after mount (avoids stale/duplicate <title>/<meta> across navigation).
  document.querySelectorAll("[data-pico-head]").forEach((el) => el.remove());
  createRoot(container).render(
    React.createElement(
      RouteContext.Provider,
      { value: routeState },
      React.createElement(Component)
    )
  );
}
`;
  }

  private async resolveImport(importer: string, specifier: string) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return specifier;

    const importerDir = importer.replace(/[\\/][^\\/]+$/, "");
    const unresolved = specifier.startsWith("/")
      ? specifier
      : `${importerDir}\\${specifier}`.replaceAll("/", "\\");

    return this.importPath(await this.resolveExistingPath(unresolved));
  }

  private async resolveExistingPath(path: string) {
    const candidates = [
      path,
      `${path}.tsx`,
      `${path}.ts`,
      `${path}.jsx`,
      `${path}.js`,
      `${path}\\index.tsx`,
      `${path}\\index.ts`,
      `${path}\\index.jsx`,
      `${path}\\index.js`,
    ];

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) return candidate;
    }

    return path;
  }

  private importPath(file: string) {
    return file.replace(/\\/g, "/");
  }

  private normalizeRoute(route: string) {
    const normalized = route.startsWith("/") ? route : `/${route}`;
    return normalized.length > 1 && normalized.endsWith("/")
      ? normalized.slice(0, -1)
      : normalized;
  }

  private safeRouteName(route: string) {
    return route === "/" ? "root" : route.replaceAll("/", "_").replace(/[^A-Za-z0-9_-]/g, "_");
  }
}
