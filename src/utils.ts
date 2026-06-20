import { pathToFileURL } from "node:url";

let freshCounter = 0;

// Bun caches imports by resolved path and ignores query strings, so re-importing a
// regenerated module returns the stale cached copy. To force a fresh evaluation we
// copy the (already up-to-date) module to a brand-new sibling path and import that.
// Only safe for modules inside a watcher-ignored dir (e.g. .picokit) — never write
// next to user source, or the dev watcher will loop on the generated files.
export async function importFresh(modulePath: string): Promise<Record<string, unknown>> {
  const uniquePath = modulePath.replace(
    /\.(tsx|ts|jsx|js|mjs)$/,
    `.fresh-${Date.now()}-${freshCounter++}.$1`,
  );
  await Bun.write(uniquePath, await Bun.file(modulePath).text());
  return import(pathToFileURL(uniquePath).href);
}
