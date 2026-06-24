import type { ReactNode } from "react";

type MetaTag =
  | { name: string; content: string }
  | { property: string; content: string };

export type HeadProps = {
  /** Document title for this route. */
  title?: string;
  /** Shorthand for <meta name="description">. */
  description?: string;
  /** Extra <meta> tags, by name or by Open Graph property. */
  meta?: MetaTag[];
  /** Any other head elements (<link>, <meta>, ...) to render verbatim. */
  children?: ReactNode;
};

export type HeadTag =
  | { kind: "title"; text: string }
  | { kind: "meta"; attrs: Record<string, string> };

export type HeadCollector = { tags: HeadTag[] };

// During the server-side compile pass (head-render.tsx) a collector is installed on
// globalThis around a synchronous render. We use a global slot rather than a React
// context because in dev a route module can be re-bundled with its own copy of this
// file — a context object would then differ between the host and the route, but a
// global property name is shared across every copy.
const COLLECTOR_KEY = "__picokitHeadCollector";

export function setHeadCollector(collector: HeadCollector | null) {
  (globalThis as Record<string, unknown>)[COLLECTOR_KEY] = collector;
}

function activeCollector(): HeadCollector | null {
  return ((globalThis as Record<string, unknown>)[COLLECTOR_KEY] as HeadCollector | null) ?? null;
}

// Per-route document metadata. Render it anywhere inside a page. During compile it
// records into the active collector (so the static page / SPA shell ships with the
// right <title>/<meta>); on the client it renders the tags and React 19 hoists them
// into <head> — which also updates them across client-side cluster navigation.
export function Head({ title, description, meta, children }: HeadProps) {
  const collector = activeCollector();

  if (collector) {
    if (title != null) collector.tags.push({ kind: "title", text: title });
    if (description != null) {
      collector.tags.push({ kind: "meta", attrs: { name: "description", content: description } });
    }
    for (const tag of meta ?? []) {
      collector.tags.push({ kind: "meta", attrs: { ...tag } });
    }
    // Freeform `children` (raw <link>/<meta> JSX) are client-only — React hoists
    // them at runtime; they are not baked into the initial HTML.
    return null;
  }

  return (
    <>
      {title != null ? <title>{title}</title> : null}
      {description != null ? <meta name="description" content={description} /> : null}
      {meta?.map((tag) => (
        <meta key={metaKey(tag)} {...tag} />
      ))}
      {children}
    </>
  );
}

function metaKey(tag: MetaTag) {
  return "name" in tag ? `name:${tag.name}` : `property:${tag.property}`;
}
