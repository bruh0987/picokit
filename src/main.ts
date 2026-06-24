import ReactDOMServer from "react-dom/server";
import { createElement } from "react";
import { watch, existsSync, cpSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { $ } from "bun";
import type { ServerWebSocket } from "bun";
import { SpaCompiler, type SpaPage } from "./spa";
import { Cluster, ClusterCompiler } from "./cluster";
import type { BackendRuntimeHandler } from "./backend";
import { matchRoute, normalizeRoute } from "./router";

export const createApp = () => {
  return new App();
};

export type ApiHandler = (req: Request) => Response | Promise<Response>;
export type ApiRoute = {
  get?: ApiHandler;
  post?: ApiHandler;
  put?: ApiHandler;
  delete?: ApiHandler;
};

export type MiddlewareContext = {
  req: Request;
  url: URL;
  path: string;
  method: string;
};

export type MiddlewareNext = () => Response | Promise<Response>;

export type Middleware = (
  ctx: MiddlewareContext,
  next: MiddlewareNext,
) => Response | Promise<Response>;

type MiddlewareRoute = {
  path?: string;
  middleware: Middleware;
};

type RuntimeApiRoutes = Record<
  string,
  {
    GET?: ApiHandler;
    POST?: ApiHandler;
    PUT?: ApiHandler;
    DELETE?: ApiHandler;
  }
>;

export type AppMode = "dev" | "prod" | "build";

export type StartConfig = {
  port?: number;
  mode?: AppMode;
  outDir?: string;
};

type StaticRoute = {
  component: React.ComponentType;
  callsite?: { file: string; line: number };
};

type CompiledApp = {
  backendRoutes: Record<string, BackendRuntimeHandler>;
  renderedPages: Record<string, string>;
  finishedApiRoutes: RuntimeApiRoutes;
  // Absolute path to the directory served at /static/*. The project's static/ dir
  // when compiling in-process; dist/static when serving a prebuilt build.
  staticAssetsDir: string;
  // Present only when serving a prebuilt dist: client bundles read from disk instead
  // of compiled on demand. Keyed by the route as registered ("/", "/app", ...).
  clientBundles?: {
    spa: Record<string, string>;
    cluster: Record<string, string>;
  };
};

// dist/manifest.json — the contract between `build` and the generated dist entrypoint.
type BuildManifest = {
  static: Record<string, string>;
  spa: Record<string, string>;
  cluster: Record<string, string>;
  backend: string[];
};

export class App {
  private spaCompiler: SpaCompiler;
  private clusterCompiler: ClusterCompiler;
  private middleware: MiddlewareRoute[];
  private freshStaticCounter = 0;

  constructor() {
    this.staticRoutes = {};
    this.apiRoutes = {};
    this.spaPages = {};
    this.clusters = {};
    this.middleware = [];
    this.spaCompiler = new SpaCompiler();
    this.clusterCompiler = new ClusterCompiler();
  }

  staticRoutes: Record<string, StaticRoute> = {};
  apiRoutes: Record<string, ApiRoute> = {};
  spaPages: Record<string, SpaPage> = {};
  clusters: Record<string, Cluster> = {};

  static(route: string, component: React.ComponentType) {
    // Capture the callsite so dev recompiles can re-import the component from
    // source — otherwise static pages render a reference frozen at startup.
    this.staticRoutes[route] = {
      component,
      callsite: SpaCompiler.getCallerLocation(),
    };
  }

  api(route: string, handlers: ApiRoute) {
    this.apiRoutes[route] = handlers;
  }

  use(middleware: Middleware): void;
  use(path: string, middleware: Middleware): void;
  use(pathOrMiddleware: string | Middleware, maybeMiddleware?: Middleware) {
    if (typeof pathOrMiddleware === "function") {
      this.middleware.push({ middleware: pathOrMiddleware });
      return;
    }

    if (!maybeMiddleware) {
      throw new Error("app.use(path, middleware) requires a middleware function.");
    }

    this.middleware.push({
      path: this.normalizePath(pathOrMiddleware),
      middleware: maybeMiddleware,
    });
  }

  spa(route: string, component: React.ComponentType) {
    this.spaPages[route] = {
      route,
      component,
      callsite: SpaCompiler.getCallerLocation(),
    };
  }

  cluster(coreRoute: string, callback: (cluster: Cluster) => void) {
    const cluster = new Cluster(coreRoute);
    callback(cluster);
    this.clusters[this.normalizePath(coreRoute)] = cluster;
  }

  // Single entrypoint. The mode (from config or argv) decides what start() does:
  // "dev" runs the watching dev server; "build" emits a dist and exits; "prod"
  // serves — from a prebuilt dist when one is present, else compiling in-process.
  async start(config: StartConfig = {}) {
    const mode = config.mode ?? this.detectMode();

    if (mode === "build") {
      return this.build(config);
    }

    if (mode === "dev") {
      return this.runDevServer(config);
    }

    // The generated dist entrypoint sets PICO_DIST; serving from it skips all
    // AST-splitting and browser bundling at startup.
    const dist = process.env.PICO_DIST;
    const compiled = dist ? await this.loadBuild(dist) : await this.compile();
    return this.serve(compiled, config);
  }

  private detectMode(): AppMode {
    if (process.argv.includes("build")) return "build";
    if (process.argv.includes("dev")) return "dev";
    return "prod";
  }

  // Offload compiling/bundling of user components, pre-render static pages, and
  // collect API + backend handlers. Pure: produces artifacts without serving, so
  // tooling (build/dev) can reuse it.
  private async compile(options: { dev?: boolean } = {}): Promise<CompiledApp> {
    await this.spaCompiler.prepare(this.spaPages);
    await this.clusterCompiler.prepare(this.clusters);
    const backendRoutes = this.createBackendRoutes([
      ...this.spaCompiler.getBackendHandlers(),
      ...this.clusterCompiler.getBackendHandlers(),
    ]);

    const renderedPages: Record<string, string> = {};
    for (const [route, page] of Object.entries(this.staticRoutes)) {
      // In dev, re-import the component from source so edits to a static page are
      // reflected; in prod the startup reference is rendered once.
      const component = options.dev
        ? (await this.resolveFreshComponent(page)) ?? page.component
        : page.component;
      renderedPages[route] = ReactDOMServer.renderToStaticMarkup(
        createElement(component),
      );
    }

    const finishedApiRoutes = Object.fromEntries(
      Object.entries(this.apiRoutes).map(([route, handlers]) => [
        route,
        {
          GET: handlers.get,
          POST: handlers.post,
          PUT: handlers.put,
          DELETE: handlers.delete,
        },
      ]),
    );

    return {
      backendRoutes,
      renderedPages,
      finishedApiRoutes,
      staticAssetsDir: `${process.cwd()}\\static`,
    };
  }

  // Ahead-of-time compile to a portable dist: minified client bundles, pre-rendered
  // static HTML, self-contained server-side handler modules, and a generated entry
  // (dist/server.ts) that boots this app in prod, serving those artifacts directly.
  private async build(config: StartConfig) {
    const outDir = config.outDir ?? `${process.cwd()}\\dist`;
    const started = performance.now();
    console.log(`${devColor.cyan}[picokit]${devColor.reset} building to ${outDir}`);

    const compiled = await this.compile();
    await $`rm -rf ${outDir}`.quiet().nothrow();

    const manifest: BuildManifest = { static: {}, spa: {}, cluster: {}, backend: [] };

    for (const [route, html] of Object.entries(compiled.renderedPages)) {
      const rel = `public\\${this.safeRouteName(route)}.html`;
      await Bun.write(`${outDir}\\${rel}`, html);
      manifest.static[route] = this.posix(rel);
    }

    for (const route of this.spaCompiler.getRoutes()) {
      const code = await this.spaCompiler.getBundle(route, { minify: true });
      if (code === undefined) continue;
      const rel = `public\\_pico\\bundle\\${this.safeRouteName(route)}.js`;
      await Bun.write(`${outDir}\\${rel}`, code);
      manifest.spa[route] = this.posix(rel);
    }

    for (const route of this.clusterCompiler.getRoutes()) {
      const code = await this.clusterCompiler.getBundle(route, { minify: true });
      if (code === undefined) continue;
      const rel = `public\\_pico\\cluster\\${this.safeRouteName(route)}.js`;
      await Bun.write(`${outDir}\\${rel}`, code);
      manifest.cluster[route] = this.posix(rel);
    }

    // Bundle each generated handler module (target: bun) so its server-side imports
    // — db client, drizzle, etc. — are inlined and the module runs without source.
    const modulePaths = [
      ...new Set([
        ...this.spaCompiler.getBackendModulePaths(),
        ...this.clusterCompiler.getBackendModulePaths(),
      ]),
    ];
    for (let i = 0; i < modulePaths.length; i++) {
      const built = await Bun.build({ entrypoints: [modulePaths[i]!], target: "bun" });
      if (!built.success || !built.outputs[0]) {
        throw new Error(`Failed to bundle backend module:\n${built.logs.join("\n")}`);
      }
      const rel = `server\\backend\\handlers-${i}.js`;
      await Bun.write(`${outDir}\\${rel}`, await built.outputs[0].text());
      manifest.backend.push(this.posix(rel));
    }

    // Copy the project's static/ assets verbatim so the prod server can serve them
    // from dist/static at /static/* without the source tree present.
    const srcStatic = `${process.cwd()}\\static`;
    if (existsSync(srcStatic)) {
      cpSync(srcStatic, `${outDir}\\static`, { recursive: true });
      console.log(`${devColor.cyan}[picokit]${devColor.reset} copied static/ assets`);
    }

    await Bun.write(`${outDir}\\manifest.json`, JSON.stringify(manifest, null, 2));
    await Bun.write(`${outDir}\\server.ts`, this.generateServerEntry());

    const ms = Math.round(performance.now() - started);
    const routes = Object.keys(manifest.static).length + Object.keys(manifest.spa).length + Object.keys(manifest.cluster).length;
    console.log(
      `${devColor.cyan}[picokit]${devColor.reset} built ${routes} route(s), ` +
        `${manifest.backend.length} backend module(s) in ${ms}ms\n` +
        `  run it with: ${devColor.yellow}bun run ${this.posix(outDir)}/server.ts${devColor.reset}`,
    );
  }

  // The generated dist entrypoint. It re-runs the user's app module (the only source
  // of middleware + api() handlers) but pins prod mode and points PICO_DIST at the
  // dist dir, so start() serves prebuilt artifacts instead of recompiling.
  private generateServerEntry() {
    const entry = this.posix(process.argv[1] ?? "");
    return `// Generated by \`picokit build\`. Run: bun run dist/server.ts
import { pathToFileURL } from "node:url";

process.env.PICO_DIST = import.meta.dir;
const entry = ${JSON.stringify(entry)};
process.argv = [process.execPath, entry, "prod"];
await import(pathToFileURL(entry).href);
`;
  }

  // Reconstruct a CompiledApp from a prebuilt dist: HTML + bundles are read from disk
  // and handlers imported from the bundled modules — no AST work, no browser bundling.
  private async loadBuild(distDir: string): Promise<CompiledApp> {
    const manifest = (await Bun.file(`${distDir}\\manifest.json`).json()) as BuildManifest;

    const renderedPages: Record<string, string> = {};
    for (const [route, rel] of Object.entries(manifest.static)) {
      renderedPages[route] = await Bun.file(`${distDir}\\${this.fromPosix(rel)}`).text();
    }

    const spa: Record<string, string> = {};
    for (const [route, rel] of Object.entries(manifest.spa)) {
      spa[route] = await Bun.file(`${distDir}\\${this.fromPosix(rel)}`).text();
    }

    const cluster: Record<string, string> = {};
    for (const [route, rel] of Object.entries(manifest.cluster)) {
      cluster[route] = await Bun.file(`${distDir}\\${this.fromPosix(rel)}`).text();
    }

    const handlers: BackendRuntimeHandler[] = [];
    for (const rel of manifest.backend) {
      const module = await import(pathToFileURL(`${distDir}\\${this.fromPosix(rel)}`).href);
      handlers.push(...((module.handlers as BackendRuntimeHandler[]) ?? []));
    }

    const finishedApiRoutes = Object.fromEntries(
      Object.entries(this.apiRoutes).map(([route, h]) => [
        route,
        { GET: h.get, POST: h.post, PUT: h.put, DELETE: h.delete },
      ]),
    );

    return {
      backendRoutes: this.createBackendRoutes(handlers),
      renderedPages,
      finishedApiRoutes,
      staticAssetsDir: `${distDir}\\static`,
      clientBundles: { spa, cluster },
    };
  }

  private safeRouteName(route: string) {
    return route === "/" ? "index" : route.replaceAll("/", "_").replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+/, "");
  }

  private posix(path: string) {
    return path.replaceAll("\\", "/");
  }

  private fromPosix(path: string) {
    return path.replaceAll("/", "\\");
  }

  private serve(compiled: CompiledApp, config: StartConfig) {
    const port = config.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);

    const server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = this.normalizePath(url.pathname);
        const method = req.method;
        const ctx = { req, url, path, method };

        return this.runMiddleware(ctx, () =>
          this.dispatch(
            req,
            url,
            path,
            method,
            compiled.renderedPages,
            compiled.backendRoutes,
            compiled.finishedApiRoutes,
            compiled.staticAssetsDir,
            compiled.clientBundles,
          )
        );
      },
    });

    console.log(`Started server on http://localhost:${server.port}`);
    return server;
  }

  // Long-lived dev server: scans once, bundles routes lazily on first request,
  // watches source for changes (re-scanning + pushing a browser reload), surfaces
  // compile errors as an overlay, and forwards browser console errors to the terminal.
  private async runDevServer(config: StartConfig) {
    let compiled = await this.compile({ dev: true });
    const clients = new Set<ServerWebSocket<undefined>>();

    const broadcast = (message: object) => {
      const payload = JSON.stringify(message);
      for (const ws of clients) ws.send(payload);
    };

    let recompiling = false;
    let pending = false;
    const recompile = async () => {
      // If a change lands mid-compile, set a flag and re-run once afterwards —
      // otherwise a fast second save is dropped and the browser keeps stale output.
      if (recompiling) {
        pending = true;
        return;
      }

      recompiling = true;
      try {
        do {
          pending = false;
          const started = performance.now();
          try {
            compiled = await this.compile({ dev: true });
            const ms = Math.round(performance.now() - started);
            console.log(`${devColor.cyan}[picokit]${devColor.reset} recompiled in ${ms}ms`);
            broadcast({ type: "reload" });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            console.error(`${devColor.red}[picokit] compile error${devColor.reset}\n${message}`);
            broadcast({ type: "error", message });
          }
        } while (pending);
      } finally {
        recompiling = false;
      }
    };

    const debouncedRecompile = debounce(recompile, 80);
    const watcher = watch(process.cwd(), { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const file = filename.toString().replaceAll("\\", "/");
      if (this.isIgnoredPath(file)) return;
      if (!/\.(tsx?|jsx?)$/.test(file)) return;
      debouncedRecompile();
    });

    const server = this.listenWithFallback(config, {
      fetch: async (req, server) => {
        const url = new URL(req.url);

        if (url.pathname === "/_pico/dev") {
          return server.upgrade(req) ? undefined : new Response("Expected WebSocket", { status: 400 });
        }

        const path = this.normalizePath(url.pathname);
        const method = req.method;
        const ctx = { req, url, path, method };

        let response: Response;
        try {
          response = await this.runMiddleware(ctx, () =>
            this.dispatch(req, url, path, method, compiled.renderedPages, compiled.backendRoutes, compiled.finishedApiRoutes, compiled.staticAssetsDir, compiled.clientBundles),
          );
        } catch (cause) {
          return this.devErrorResponse(cause, path);
        }

        return this.injectDevClient(response);
      },
      websocket: {
        open: (ws) => {
          clients.add(ws);
        },
        close: (ws) => {
          clients.delete(ws);
        },
        message: (_ws, raw) => {
          try {
            const data = JSON.parse(String(raw));
            if (data?.type === "console") {
              console.log(`${devColor.yellow}[browser]${devColor.reset} ${data.message}`);
            }
          } catch {
            // ignore malformed dev messages
          }
        },
      },
    });

    process.on("SIGINT", () => {
      watcher.close();
      server.stop(true);
      process.exit(0);
    });

    // Warm Bun.build's caches in the background so the first edit-triggered rebuild
    // is fast instead of paying the bundler's cold-start on the first request.
    void this.warmBundles();

    console.log(`${devColor.cyan}[picokit]${devColor.reset} dev server on http://localhost:${server.port}`);
    return server;
  }

  private listenWithFallback(
    config: StartConfig,
    options: { fetch: (req: Request, server: import("bun").Server<undefined>) => Response | Promise<Response | undefined> | undefined; websocket: import("bun").WebSocketHandler<undefined> },
  ) {
    const startPort = config.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);

    for (let port = startPort; port < startPort + 20; port++) {
      try {
        return Bun.serve({ port, fetch: options.fetch, websocket: options.websocket });
      } catch (cause) {
        // EADDRINUSE: already bound. EACCES/EADDRNOTAVAIL: privileged or OS-reserved
        // (Windows excluded port ranges). All are recoverable by trying the next port.
        const code = (cause as { code?: string })?.code;
        if (code !== "EADDRINUSE" && code !== "EACCES" && code !== "EADDRNOTAVAIL") throw cause;
        console.log(`${devColor.yellow}[picokit]${devColor.reset} port ${port} unavailable (${code}), trying ${port + 1}`);
      }
    }

    throw new Error(`No free port found in range ${startPort}-${startPort + 19}.`);
  }

  private injectDevClient(response: Response) {
    const contentType = response.headers.get("Content-Type") ?? "";
    if (!contentType.includes("text/html")) return response;

    return response
      .text()
      .then((html) => {
        const injected = html.includes("</body>")
          ? html.replace("</body>", `${DEV_CLIENT_SCRIPT}</body>`)
          : html + DEV_CLIENT_SCRIPT;
        return new Response(injected, { status: response.status, headers: response.headers });
      });
  }

  private devErrorResponse(cause: unknown, path: string) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`${devColor.red}[picokit] request error${devColor.reset}\n${message}`);

    // A failed bundle is loaded via <script>, so respond with JS that paints the
    // overlay; everything else is a navigation, so respond with the overlay page.
    if (path.startsWith("/_pico/bundle") || path.startsWith("/_pico/cluster")) {
      return new Response(`(${renderOverlay.toString()})(${JSON.stringify(message)});`, {
        status: 500,
        headers: { "Content-Type": "text/javascript" },
      });
    }

    return new Response(
      `<!DOCTYPE html><html><body><script>(${renderOverlay.toString()})(${JSON.stringify(message)});</script>${DEV_CLIENT_SCRIPT}</body></html>`,
      { status: 500, headers: { "Content-Type": "text/html" } },
    );
  }

  private async warmBundles() {
    await Promise.all([
      ...this.spaCompiler.getRoutes().map((route) => this.spaCompiler.getBundle(route).catch(() => {})),
      ...this.clusterCompiler.getRoutes().map((route) => this.clusterCompiler.getBundle(route).catch(() => {})),
    ]);
  }

  private isIgnoredPath(file: string) {
    return (
      file.includes("/node_modules/") ||
      file.includes("/.picokit/") ||
      file.includes("/.git/") ||
      file.includes("/dist/") ||
      file.startsWith("node_modules/") ||
      file.startsWith(".picokit/") ||
      file.startsWith(".git/") ||
      file.startsWith("dist/")
    );
  }

  // Re-render a static page from its current source on a dev recompile. The defining
  // module is bundled with Bun.build (which reads from disk, so it reflects edits)
  // into a unique .picokit path and imported fresh — Bun caches imports by path and
  // ignores query strings, and writing next to user source would loop the watcher.
  private async resolveFreshComponent(page: StaticRoute): Promise<React.ComponentType | undefined> {
    const local = page.component.name;
    const file = page.callsite?.file;
    if (!local || !file) return undefined;

    try {
      const source = await Bun.file(file).text();
      const target = await this.locateComponentModule(source, local, file);
      if (!target) return undefined;

      const built = await Bun.build({ entrypoints: [target.path], target: "bun" });
      if (!built.success || !built.outputs[0]) return undefined;

      const tmp = `${process.cwd()}\\.picokit\\static-${Date.now()}-${this.freshStaticCounter++}.mjs`;
      await Bun.write(tmp, await built.outputs[0].text());
      const module = await import(pathToFileURL(tmp).href);
      const fresh = target.exportName === "default" ? module.default : module[target.exportName];
      return typeof fresh === "function" ? (fresh as React.ComponentType) : undefined;
    } catch {
      return undefined;
    }
  }

  private async locateComponentModule(source: string, local: string, importerFile: string) {
    const imports = source.matchAll(/import\s+([^;]+?)\s+from\s+["']([^"']+)["']/g);

    for (const match of imports) {
      const clause = match[1]?.trim();
      const specifier = match[2];
      if (!clause || !specifier) continue;

      const defaultName = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/)?.[1];
      if (defaultName === local) {
        const path = await this.resolveModulePath(importerFile, specifier);
        return path ? { path, exportName: "default" } : undefined;
      }

      const named = clause.match(/\{([^}]+)\}/)?.[1];
      if (!named) continue;

      for (const part of named.split(",")) {
        const [imported, alias = imported] = part.trim().split(/\s+as\s+/);
        if (alias?.trim() === local && imported?.trim()) {
          const path = await this.resolveModulePath(importerFile, specifier);
          return path ? { path, exportName: imported.trim() } : undefined;
        }
      }
    }

    // Component defined and exported in the same file the route was registered from.
    if (new RegExp(`export\\s+(?:const|function)\\s+${local}\\b`).test(source)) {
      return { path: importerFile, exportName: local };
    }

    return undefined;
  }

  private async resolveModulePath(importerFile: string, specifier: string) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;

    const dir = importerFile.replace(/[\\/][^\\/]+$/, "");
    const base = (specifier.startsWith("/") ? specifier : `${dir}\\${specifier}`).replaceAll("/", "\\");
    const candidates = [
      base,
      `${base}.tsx`,
      `${base}.ts`,
      `${base}.jsx`,
      `${base}.js`,
      `${base}\\index.tsx`,
      `${base}\\index.ts`,
    ];

    for (const candidate of candidates) {
      if (await Bun.file(candidate).exists()) return candidate;
    }

    return undefined;
  }

  private async runMiddleware(ctx: MiddlewareContext, dispatch: MiddlewareNext) {
    const middleware = this.middleware
      .filter((route) => !route.path || this.pathMatches(ctx.path, route.path));
    let index = -1;

    const run = async (nextIndex: number): Promise<Response> => {
      if (nextIndex <= index) {
        throw new Error("Middleware next() called multiple times.");
      }

      index = nextIndex;
      const route = middleware[nextIndex];

      if (!route) {
        return dispatch();
      }

      return route.middleware(ctx, () => run(nextIndex + 1));
    };

    return run(0);
  }

  private async dispatch(
    req: Request,
    url: URL,
    path: string,
    method: string,
    renderedPages: Record<string, string>,
    backendRoutes: Record<string, BackendRuntimeHandler>,
    finishedApiRoutes: RuntimeApiRoutes,
    staticAssetsDir: string,
    clientBundles?: CompiledApp["clientBundles"],
  ) {
    // STATIC ASSETS — files from the project's static/ dir, served verbatim at
    // /static/*. Checked first so the prefix is reserved; a miss falls through.
    if (path.startsWith("/static/")) {
      const asset = await this.serveStaticAsset(staticAssetsDir, path);
      if (asset) return asset;
    }

    // STATIC PAGES
    for (const [route, htmlString] of Object.entries(renderedPages)) {
      if (path === this.normalizePath(route)) {
        return new Response(htmlString, {
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    // API ROUTES
    if (path.startsWith("/_pico/backend/")) {
      const id = decodeURIComponent(path.replace("/_pico/backend/", ""));
      const handler = backendRoutes[id];
      if (!handler) {
        return Response.json({ error: `Backend route [${id}] not found.` }, { status: 404 });
      }

      try {
        const input = await this.readBackendInput(req, url);
        const data = await handler.handler({ req, input });
        return Response.json({ data });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    for (const [route, handlers] of Object.entries(finishedApiRoutes)) {
      if (path === this.normalizePath(route)) {
        const handler = handlers[method as keyof typeof handlers];
        if (handler) {
          let res = handler(req);
          if (res instanceof Promise) res = await res;
          return res;
        }
      }
    }

    // SERVE CLIENT SCRIPTS — from the prebuilt dist when present, else compiled lazily.
    if (path.startsWith("/_pico/bundle")) {
      const targetRoute = decodeURIComponent(path.replace("/_pico/bundle", "")) || "/";
      const jsCode = clientBundles?.spa[targetRoute] ?? (await this.spaCompiler.getBundle(targetRoute));
      if (jsCode) {
        return new Response(jsCode, {
          headers: { "Content-Type": "text/javascript" },
        });
      }
    }

    if (path.startsWith("/_pico/cluster")) {
      const targetRoute = path.replace("/_pico/cluster", "") || "/";
      const jsCode = clientBundles?.cluster[targetRoute] ?? (await this.clusterCompiler.getBundle(targetRoute));
      if (jsCode) {
        return new Response(jsCode, {
          headers: { "Content-Type": "text/javascript" },
        });
      }
    }

    // SERVE SPA HTML SHELLS
    const spaPage = this.findSpaPage(path);
    if (spaPage) {
      const htmlShell = this.spaCompiler.generateHtmlShell(spaPage.route);
      return new Response(htmlShell, {
        headers: { "Content-Type": "text/html" },
      });
    }

    const cluster = this.findCluster(path);
    if (cluster) {
      return new Response(this.clusterCompiler.generateHtmlShell(cluster.coreRoute), {
        headers: { "Content-Type": "text/html" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  // Resolve /static/<path> to a file under staticAssetsDir. Rejects empty, dotted,
  // and traversal segments so a crafted path can't escape the asset root, then
  // streams the file — Bun sets Content-Type from the extension.
  private async serveStaticAsset(staticDir: string, path: string): Promise<Response | undefined> {
    const rel = decodeURIComponent(path.slice("/static/".length));
    const segments = rel.split("/");
    if (
      segments.length === 0 ||
      segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))
    ) {
      return undefined;
    }

    const file = Bun.file(`${staticDir}\\${segments.join("\\")}`);
    if (!(await file.exists())) return undefined;

    return new Response(file);
  }

  private async readBackendInput(req: Request, url: URL) {
    if (req.method === "GET") {
      const input = url.searchParams.get("input");
      return input === null ? null : JSON.parse(input);
    }

    const body = (await req.json().catch(() => ({}))) as { input?: unknown };
    return body.input ?? null;
  }

  private pathMatches(path: string, prefix: string) {
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  private findCluster(path: string) {
    return Object.entries(this.clusters).find(
      ([coreRoute]) => path === coreRoute || path.startsWith(`${coreRoute}/`),
    )?.[1];
  }

  private findSpaPage(path: string) {
    return Object.values(this.spaPages).find((page) =>
      matchRoute(page.route, path) !== undefined
    );
  }

  private normalizePath(path: string) {
    return normalizeRoute(path);
  }

  private createBackendRoutes(handlers: BackendRuntimeHandler[]) {
    const routes: Record<string, BackendRuntimeHandler> = {};

    for (const handler of handlers) {
      if (routes[handler.id]) {
        throw new Error(`Duplicate useBackend id [${handler.id}]. Backend ids must be unique.`);
      }

      routes[handler.id] = handler;
    }

    return routes;
  }
}

const devColor = {
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
};

function debounce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// Serialized via .toString() and shipped to the browser, so keep it self-contained
// plain JS with no references to module scope. `document` is the browser global —
// declared here only to satisfy the server-side type checker (erased at runtime).
declare const document: any;

function renderOverlay(message: string) {
  var id = "__picokit_overlay__";
  var existing = document.getElementById(id);
  if (existing) existing.remove();
  var el = document.createElement("div");
  el.id = id;
  el.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.88);color:#ff6b6b;font:13px/1.5 ui-monospace,monospace;padding:24px;white-space:pre-wrap;overflow:auto;";
  el.textContent = "picokit error\n\n" + message;
  document.body.appendChild(el);
}

const DEV_CLIENT_SCRIPT = `<script>
(function(){
  var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/_pico/dev");
  ws.onmessage = function(e){
    var data;
    try { data = JSON.parse(e.data); } catch (_) { return; }
    if (data.type === "reload") location.reload();
    if (data.type === "error") (${renderOverlay.toString()})(data.message);
  };
  function send(message){ try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "console", message: message })); } catch (_) {} }
  var origError = console.error;
  console.error = function(){ send(Array.prototype.join.call(arguments, " ")); return origError.apply(console, arguments); };
  window.addEventListener("error", function(ev){ send(String(ev.message)); });
  window.addEventListener("unhandledrejection", function(ev){ send("Unhandled rejection: " + String(ev.reason)); });
})();
</script>`;
