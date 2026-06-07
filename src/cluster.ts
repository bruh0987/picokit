import { $ } from "bun";
import { BackendCompiler } from "./backend-compiler";
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

export class Cluster {
  routes: Record<string, ClusterRoute> = {};

  constructor(public coreRoute: string) {}

  route(route: string, component: React.ComponentType) {
    this.routes[route] = {
      route,
      component,
      callsite: ClusterCompiler.getCallerLocation(),
    };
  }
}

export class ClusterCompiler {
  private tmpDir = `${process.cwd()}\\.picokit`;
  private bundledClusters: Record<string, string> = {};
  private backendHandlers: BackendRuntimeHandler[] = [];

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

  async compile(clusters: Record<string, Cluster>) {
    this.bundledClusters = {};
    this.backendHandlers = [];

    await $`mkdir -p ${this.tmpDir}`.quiet();
    const backendCompiler = new BackendCompiler(this.tmpDir);

    for (const cluster of Object.values(clusters)) {
      const routes = await Promise.all(
        Object.values(cluster.routes).map(async (route) => {
          const componentImport = await this.resolveComponentImport(route);
          const backendResult = await backendCompiler.compileComponentFile(
            componentImport.specifier,
            route.route,
            componentImport.local,
          );
          const backendModule = await import(backendResult.handlers[0]?.modulePath ?? "data:text/javascript,export const handlers=[]");
          this.backendHandlers.push(...(backendModule.handlers ?? []));

          return {
            route: route.route,
            componentImport: { ...componentImport, specifier: this.importPath(backendResult.clientFile) },
          };
        }),
      );
      const entryPath = `${this.tmpDir}\\${this.safeRouteName(cluster.coreRoute)}-cluster-entry.tsx`;

      await Bun.write(entryPath, this.generateEntry(cluster.coreRoute, routes));

      const buildResult = await Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        minify: false,
      });

      if (!buildResult.success) {
        throw new Error(
          `Build failed for cluster [${cluster.coreRoute}]: ${buildResult.logs.join("\n")}`,
        );
      }

      const output = buildResult.outputs[0];
      if (!output) {
        throw new Error(`Build produced no output for cluster [${cluster.coreRoute}]`);
      }

      this.bundledClusters[cluster.coreRoute] = await output.text();
    }
  }

  getBundle(coreRoute: string): string | undefined {
    return this.bundledClusters[coreRoute];
  }

  getBackendHandlers() {
    return this.backendHandlers;
  }

  generateHtmlShell(coreRoute: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SPA Cluster</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/_pico/cluster${coreRoute}"></script>
</body>
</html>`;
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
  ) {
    const imports = routes
      .map(({ componentImport }, index) => this.generateImport(componentImport, `Route${index}`))
      .join("\n");

    return `import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { RouteContext, matchRoute } from "../src/router";
${imports}

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

function Router() {
  const path = useSyncExternalStore(subscribe, getPath, () => "/");
  const match = routes
    .map((route) => ({ ...route, params: matchRoute(route.route, path) }))
    .find((route) => route.params);
  const fallback = routes.find((route) => route.route === "/");
  const route = match || fallback;

  if (!route) return React.createElement("h1", null, "Not Found");

  return React.createElement(
    RouteContext.Provider,
    {
      value: {
        pathname: path,
        params: route.params || {},
        search: new URLSearchParams(window.location.search),
      },
    },
    React.createElement(route.Component)
  );
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || link.origin !== window.location.origin || !link.pathname.startsWith(base)) return;
  event.preventDefault();
  window.history.pushState({}, "", link.href);
  window.dispatchEvent(new PopStateEvent("popstate"));
});

const container = document.getElementById("root");
if (container) {
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
