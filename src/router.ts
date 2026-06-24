import { createContext, useContext } from "react";

export type RouteParams = Record<string, string>;

export type RouteState = {
  pathname: string;
  params: RouteParams;
  search: URLSearchParams;
  navigate: (to: string) => void;
  back: () => void;
};

export const RouteContext = createContext<RouteState>({
  pathname: "/",
  params: {},
  search: new URLSearchParams(),
  navigate: () => {},
  back: () => {},
});

export function useRoute() {
  return useContext(RouteContext);
}

export function normalizeRoute(route: string) {
  const normalized = route.startsWith("/") ? route : `/${route}`;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export function getRouteParamNames(route: string) {
  return splitRoute(route)
    .filter((part) => part.startsWith(":"))
    .map((part) => part.slice(1));
}

export function matchRoute(route: string, pathname: string): RouteParams | undefined {
  const routeParts = splitRoute(route);
  const pathParts = splitRoute(pathname);

  if (routeParts.length !== pathParts.length) return undefined;

  const params: RouteParams = {};

  for (let index = 0; index < routeParts.length; index++) {
    const routePart = routeParts[index];
    const pathPart = pathParts[index];

    if (!routePart || pathPart === undefined) return undefined;

    if (routePart.startsWith(":")) {
      const name = routePart.slice(1);
      if (!name) return undefined;
      params[name] = decodeURIComponent(pathPart);
      continue;
    }

    if (routePart !== pathPart) return undefined;
  }

  return params;
}

function splitRoute(route: string) {
  return normalizeRoute(route).split("/").filter(Boolean);
}
