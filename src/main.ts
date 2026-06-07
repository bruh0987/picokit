import ReactDOMServer from "react-dom/server";
import { createElement } from "react";
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

export class App {
  private spaCompiler: SpaCompiler;
  private clusterCompiler: ClusterCompiler;

  constructor() {
    this.staticRoutes = {};
    this.apiRoutes = {};
    this.spaPages = {};
    this.clusters = {};
    this.spaCompiler = new SpaCompiler();
    this.clusterCompiler = new ClusterCompiler();
  }

  staticRoutes: Record<string, React.ComponentType> = {};
  apiRoutes: Record<string, ApiRoute> = {};
  spaPages: Record<string, SpaPage> = {};
  clusters: Record<string, Cluster> = {};

  static(route: string, component: React.ComponentType) {
    this.staticRoutes[route] = component;
  }

  api(route: string, handlers: ApiRoute) {
    this.apiRoutes[route] = handlers;
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

  async listen(port: number) {
    // 1. Offload compiling/bundling of user components to the SPA engine
    await this.spaCompiler.compile(this.spaPages);
    await this.clusterCompiler.compile(this.clusters);
    const backendRoutes = this.createBackendRoutes([
      ...this.spaCompiler.getBackendHandlers(),
      ...this.clusterCompiler.getBackendHandlers(),
    ]);

    // Pre-evaluate standard static pages
    const renderedPages: Record<string, string> = {};
    for (const [route, component] of Object.entries(this.staticRoutes)) {
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

    const server = Bun.serve({
      port: port,
      fetch: async (req) => {
        const { pathname } = new URL(req.url);
        let path = pathname;
        if (path.length > 1 && path.endsWith("/")) {
          path = path.slice(0, -1);
        }
        let method = req.method;

        // STATIC PAGES
        for (const [route, htmlString] of Object.entries(renderedPages)) {
          if (path === route) {
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
            const body = (await req.json().catch(() => ({}))) as { input?: unknown };
            const data = await handler.handler({ req, input: body.input });
            return Response.json({ data });
          } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            return Response.json({ error: message }, { status: 500 });
          }
        }

        for (const [route, handlers] of Object.entries(finishedApiRoutes)) {
          if (path === route) {
            const handler = handlers[method as keyof typeof handlers];
            if (handler) {
              let res = handler(req);
              if (res instanceof Promise) res = await res;
              return res;
            }
          }
        }

        // SERVE CLIENT SCRIPTS
        if (path.startsWith("/_pico/bundle")) {
          const targetRoute = decodeURIComponent(path.replace("/_pico/bundle", "")) || "/";
          const jsCode = this.spaCompiler.getBundle(targetRoute);
          if (jsCode) {
            return new Response(jsCode, {
              headers: { "Content-Type": "text/javascript" },
            });
          }
        }

        if (path.startsWith("/_pico/cluster")) {
          const targetRoute = path.replace("/_pico/cluster", "") || "/";
          const jsCode = this.clusterCompiler.getBundle(targetRoute);
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
      },
    });

    console.log(`Started server on http://localhost:${server.port}`);
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
