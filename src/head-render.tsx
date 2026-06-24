import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouteContext, normalizeRoute } from "./router";
import { setHeadCollector, type HeadCollector, type HeadTag } from "./head";

// Server-only. Statically render a route component once to (a) collect the metadata
// its <Head> declares and (b) produce body markup for static pages. Backend hooks
// are render-safe (they fetch in an effect, which never runs here), so this needs
// no DB or browser — it just exercises the component's initial render.
export function renderRoute(component: ComponentType, route = "/"): { head: string; body: string } {
  const collector: HeadCollector = { tags: [] };
  const routeState = {
    pathname: normalizeRoute(route),
    params: {},
    search: new URLSearchParams(),
    navigate: () => {},
    back: () => {},
  };

  // renderToStaticMarkup is synchronous, so installing the collector for the duration
  // of this render is safe — no other render can interleave with it.
  setHeadCollector(collector);
  try {
    const body = renderToStaticMarkup(
      createElement(RouteContext.Provider, { value: routeState }, createElement(component)),
    );
    return { head: renderHeadTags(collector.tags), body };
  } catch {
    // A page that can't render without data or browser globals contributes no baked
    // head and falls back to an empty body; client-side <Head> hoisting still sets
    // the title once the bundle runs.
    return { head: "", body: "" };
  } finally {
    setHeadCollector(null);
  }
}

// Just the baked <head> string for a route — used by the SPA/cluster shells, which
// only need metadata (their body is rendered in the browser).
export function collectHead(component: ComponentType, route = "/"): string {
  return renderRoute(component, route).head;
}

// Baked tags carry data-pico-head so hydrating client entries can strip them and
// hand head ownership to React (whose <Head> then manages the head on its own).
function renderHeadTags(tags: HeadTag[]): string {
  return tags
    .map((tag) =>
      tag.kind === "title"
        ? `  <title data-pico-head>${escapeHtml(tag.text)}</title>`
        : `  <meta data-pico-head ${Object.entries(tag.attrs)
            .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
            .join(" ")}>`,
    )
    .join("\n");
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
