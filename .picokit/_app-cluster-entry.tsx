import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { RouteContext, matchRoute } from "../src/router";
import { AppPage as Route0 } from "C:/Users/igi/Desktop/picokit/.picokit/_Users_igi_Desktop_picokit_example_src___components_components_tsx-client.tsx";
import { TodoDetailPage as Route1 } from "C:/Users/igi/Desktop/picokit/.picokit/_Users_igi_Desktop_picokit_example_src___components_TodoDetailPage_tsx-client.tsx";

const base = "/app";
const routes = [
  { route: "/", Component: Route0 },
  { route: "/todos/:id", Component: Route1 },
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
