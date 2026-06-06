import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { AppPage as Route0 } from "C:/Users/igi/Desktop/picokit/.picokit/_Users_igi_Desktop_picokit_example_src___components_components_tsx-client.tsx";

const base = "/app";
const routes = {
  "/": Route0,
};

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
  const Component = routes[path] || routes["/"];
  return Component ? React.createElement(Component) : React.createElement("h1", null, "Not Found");
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
