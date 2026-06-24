import { $ } from "bun";
import { BackendCompiler, type BackendCompileResult } from "./backend-compiler";
import { collectHead } from "./head-render";
import { importFresh } from "./utils";
import type { BackendRuntimeHandler } from "./backend";

type SourceLocation = {
  file: string;
  line: number;
};

type ComponentImport =
  | { kind: "named"; imported: string; local: string; specifier: string }
  | { kind: "default"; local: string; specifier: string }
  | { kind: "local"; local: string; specifier: string };

export type ClusterRoute = {
  route: string;
  component: React.ComponentType;
  callsite?: SourceLocation;
};

export type LayoutComponent = React.ComponentType<{ children: React.ReactNode }>;

export type ClusterLayout = {
  component: LayoutComponent;
  callsite?: SourceLocation;
};

export class Cluster {
  routes: Record<string, ClusterRoute> = {};
  layoutComponent?: ClusterLayout;

  constructor(public coreRoute: string) {}

  route(route: string, component: React.ComponentType) {
    this.routes[route] = {
      route,
      component,
      callsite: ClusterCompiler.getCallerLocation(),
    };
  }

  layout(component: LayoutComponent) {
    this.layoutComponent = {
      component,
      callsite: ClusterCompiler.getCallerLocation(),
    };
  }
}

export class ClusterCompiler {
  private tmpDir = `${process.cwd()}\\.picokit`;
  private entries: Record<string, string> = {};
  private heads: Record<string, string> = {};
  private bundleCache: Record<string, string> = {};
  private backendHandlers: BackendRuntimeHandler[] = [];
  private collectedModules = new Set<string>();

  static getCallerLocation(): SourceLocation | undefined {
    const stack = new Error().stack;
    const callerLine = stack
      ?.split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          !line.includes("src\\main.ts") &&
          !line.includes("src/main.ts") &&
          !line.includes("src\\cluster.ts") &&
          !line.includes("src/cluster.ts") &&
          line.includes(":"),
      );

    const match = callerLine?.match(/\(?([A-Za-z]:[^\n:]+):(\d+):\d+\)?$/);
    if (!match || !match[1] || !match[2]) return undefined;

    return { file: match[1], line: Number(match[2]) };
  }

  // Scan phase: AST-split every route + layout in each cluster, register backend
  // handlers, and write the cluster client entry — without bundling. getBundle()
  // builds a cluster lazily on first request.
  async prepare(clusters: Record<string, Cluster>) {
    this.entries = {};
    this.heads = {};
    this.bundleCache = {};
    this.backendHandlers = [];
    this.collectedModules = new Set();

    await $`mkdir -p ${this.tmpDir}`.quiet();
    const backendCompiler = new BackendCompiler(this.tmpDir);

    for (const cluster of Object.values(clusters)) {
      // Compile routes sequentially: two routes can share one source file, and
      // concurrent Bun.write calls to that file's generated module would race
      // (an import() can observe the file mid-truncation and register zero handlers).
      const routes: Array<{ route: string; componentImport: ComponentImport }> = [];
      for (const route of Object.values(cluster.routes)) {
        const componentImport = await this.resolveComponentImport(route);
        const backendResult = await backendCompiler.compileComponentFile(
          componentImport.specifier,
          route.route,
          componentImport.local,
        );
        await this.collectBackendHandlers(backendResult);

        routes.push({
          route: route.route,
          componentImport: { ...componentImport, specifier: this.importPath(backendResult.clientFile) },
        });
      }
      const layoutImport = await this.resolveLayoutImport(cluster, backendCompiler);
      const entryPath = `${this.tmpDir}\\${this.safeRouteName(cluster.coreRoute)}-cluster-entry.tsx`;

      await Bun.write(entryPath, this.generateEntry(cluster.coreRoute, routes, layoutImport));
      this.entries[cluster.coreRoute] = entryPath;
      // Bake the head of the route the shell first lands on (the cluster's "/", or
      // the first declared route). Client-side navigation updates it from there.
      const indexRoute = cluster.routes["/"] ?? Object.values(cluster.routes)[0];
      if (indexRoute) {
        this.heads[cluster.coreRoute] = collectHead(indexRoute.component, indexRoute.route);
      }
    }
  }

  async getBundle(coreRoute: string, options: { minify?: boolean } = {}): Promise<string | undefined> {
    if (this.bundleCache[coreRoute]) return this.bundleCache[coreRoute];

    const entryPath = this.entries[coreRoute];
    if (!entryPath) return undefined;

    const buildResult = await Bun.build({
      entrypoints: [entryPath],
      target: "browser",
      minify: options.minify ?? false,
    });

    if (!buildResult.success) {
      throw new Error(
        `Build failed for cluster [${coreRoute}]: ${buildResult.logs.join("\n")}`,
      );
    }

    const output = buildResult.outputs[0];
    if (!output) {
      throw new Error(`Build produced no output for cluster [${coreRoute}]`);
    }

    const code = await output.text();
    this.bundleCache[coreRoute] = code;
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

  generateHtmlShell(coreRoute: string): string {
    const head = this.heads[coreRoute];
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${head ? `${head}\n` : ""}</head>
<body>
  <div id="root"></div>
  <script type="module" src="/_pico/cluster${coreRoute}"></script>
</body>
</html>`;
  }

  private async resolveLayoutImport(
    cluster: Cluster,
    backendCompiler: BackendCompiler,
  ): Promise<ComponentImport | undefined> {
    if (!cluster.layoutComponent) return undefined;

    const componentImport = await this.resolveComponentImport({
      route: `${cluster.coreRoute} (layout)`,
      // The resolver only reads the component's name + callsite, not its props.
      component: cluster.layoutComponent.component as React.ComponentType,
      callsite: cluster.layoutComponent.callsite,
    });
    const backendResult = await backendCompiler.compileComponentFile(componentImport.specifier);
    await this.collectBackendHandlers(backendResult);

    return { ...componentImport, specifier: this.importPath(backendResult.clientFile) };
  }

  private async collectBackendHandlers(backendResult: BackendCompileResult) {
    // All handlers in a file share one generated module; import it once even if
    // several routes (or a layout) live in the same source file.
    const modulePath = backendResult.handlers[0]?.modulePath;
    if (!modulePath || this.collectedModules.has(modulePath)) return;

    this.collectedModules.add(modulePath);
    // importFresh re-evaluates edited handler bodies on a dev recompile (Bun caches
    // by path and ignores query strings, so a plain re-import would be stale).
    const backendModule = await importFresh(modulePath);
    this.backendHandlers.push(...((backendModule.handlers as BackendRuntimeHandler[]) ?? []));
  }

  private async resolveComponentImport(route: ClusterRoute): Promise<ComponentImport> {
    const local = route.component.name;
    if (!local) {
      throw new Error(`Cluster route [${route.route}] needs a named component.`);
    }

    const file = route.callsite?.file;
    if (!file) {
      throw new Error(`Could not locate cluster route [${route.route}] callsite.`);
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
      `Could not resolve component [${local}] for cluster route [${route.route}]. Export it from the route file or import it with a standard ES import.`,
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

  private generateEntry(
    coreRoute: string,
    routes: Array<{ route: string; componentImport: ComponentImport }>,
    layoutImport?: ComponentImport,
  ) {
    const imports = routes
      .map(({ componentImport }, index) => this.generateImport(componentImport, `Route${index}`))
      .join("\n");
    const layoutImportLine = layoutImport ? this.generateImport(layoutImport, "Layout") : "";

    return `import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { RouteContext, matchRoute } from "../src/router";
${imports}
${layoutImportLine}

const base = ${JSON.stringify(this.normalizeRoute(coreRoute))};
const routes = [
${routes
  .map(
    ({ route }, index) =>
      `  { route: ${JSON.stringify(this.normalizeRoute(route))}, Component: Route${index} },`,
  )
  .join("\n")}
];

function getPath() {
  const path = window.location.pathname;
  const nested = path.startsWith(base) ? path.slice(base.length) : "/";
  return nested === "" ? "/" : nested;
}

function subscribe(callback) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function navigate(to) {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function Router() {
  const path = useSyncExternalStore(subscribe, getPath, () => "/");
  const match = routes
    .map((route) => ({ ...route, params: matchRoute(route.route, path) }))
    .find((route) => route.params);
  const fallback = routes.find((route) => route.route === "/");
  const route = match || fallback;

  const page = route
    ? React.createElement(route.Component)
    : React.createElement("h1", null, "Not Found");
  const content = ${layoutImport ? "React.createElement(Layout, null, page)" : "page"};

  return React.createElement(
    RouteContext.Provider,
    {
      value: {
        pathname: path,
        params: route?.params || {},
        search: new URLSearchParams(window.location.search),
        navigate,
        back: () => window.history.back(),
      },
    },
    content
  );
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || link.origin !== window.location.origin || !link.pathname.startsWith(base)) return;
  event.preventDefault();
  navigate(link.href);
});

const container = document.getElementById("root");
if (container) {
  // Drop the server-baked head tags so React's <Head> becomes the sole owner of
  // the head after mount (avoids stale/duplicate <title>/<meta> across navigation).
  document.querySelectorAll("[data-pico-head]").forEach((el) => el.remove());
  createRoot(container).render(React.createElement(Router));
}
`;
  }

  private generateImport(componentImport: ComponentImport, alias: string) {
    if (componentImport.kind === "default") {
      return `import ${alias} from "${componentImport.specifier}";`;
    }

    const imported =
      componentImport.kind === "named" ? componentImport.imported : componentImport.local;
    return `import { ${imported} as ${alias} } from "${componentImport.specifier}";`;
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
