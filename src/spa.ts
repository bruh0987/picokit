import { $ } from "bun";
import { BackendCompiler } from "./backend-compiler";
import type { BackendRuntimeHandler } from "./backend";

export type SpaPage = {
  route: string;
  component: React.ComponentType;
  callsite?: SourceLocation;
};

type SourceLocation = {
  file: string;
  line: number;
};

type ComponentImport =
  | { kind: "named"; imported: string; local: string; specifier: string }
  | { kind: "default"; local: string; specifier: string }
  | { kind: "local"; local: string; specifier: string };

export class SpaCompiler {
  private tmpDir: string;
  private bundledSpas: Record<string, string> = {};
  private backendHandlers: BackendRuntimeHandler[] = [];

  constructor() {
    this.tmpDir = `${process.cwd()}\\.picokit`;
  }

  static getCallerLocation(): SourceLocation | undefined {
    const stack = new Error().stack;
    const callerLine = stack
      ?.split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          !line.includes("src\\main.ts") &&
          !line.includes("src/main.ts") &&
          !line.includes("src\\spa.ts") &&
          !line.includes("src/spa.ts") &&
          line.includes(":"),
      );

    const match = callerLine?.match(/\(?([A-Za-z]:[^\n:]+):(\d+):\d+\)?$/);
    if (!match || !match[1] || !match[2]) return undefined;

    return { file: match[1], line: Number(match[2]) };
  }

  async compile(spaPages: Record<string, SpaPage>) {
    this.bundledSpas = {};
    this.backendHandlers = [];

    await $`rm -rf ${this.tmpDir}`.quiet();
    await $`mkdir -p ${this.tmpDir}`.quiet();
    const backendCompiler = new BackendCompiler(this.tmpDir);

    for (const page of Object.values(spaPages)) {
      const componentImport = await this.resolveComponentImport(page);
      const backendResult = await backendCompiler.compileComponentFile(componentImport.specifier);
      const backendModule = await import(backendResult.handlers[0]?.modulePath ?? "data:text/javascript,export const handlers=[]");
      this.backendHandlers.push(...(backendModule.handlers ?? []));
      const clientComponentImport = { ...componentImport, specifier: this.importPath(backendResult.clientFile) };
      const entryPath = `${this.tmpDir}\\${this.safeRouteName(page.route)}-entry.tsx`;

      await Bun.write(entryPath, this.generateEntry(clientComponentImport));

      const buildResult = await Bun.build({
        entrypoints: [entryPath],
        target: "browser",
        minify: false,
      });

      if (!buildResult.success) {
        throw new Error(
          `Build failed for SPA route [${page.route}]: ${buildResult.logs.join("\n")}`,
        );
      }

      const output = buildResult.outputs[0];
      if (!output) {
        throw new Error(`Build produced no output for SPA route [${page.route}]`);
      }

      this.bundledSpas[page.route] = await output.text();
    }
  }

  getBundle(route: string): string | undefined {
    return this.bundledSpas[route];
  }

  getBackendHandlers() {
    return this.backendHandlers;
  }

  generateHtmlShell(route: string): string {
    const bundleUrl = `/_pico/bundle${route === "/" ? "" : route}`;
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SPA Page</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${bundleUrl}"></script>
</body>
</html>`;
  }

  private async resolveComponentImport(page: SpaPage): Promise<ComponentImport> {
    const local = page.component.name;
    if (!local) {
      throw new Error(`SPA route [${page.route}] needs a named component.`);
    }

    const file = page.callsite?.file;
    if (!file) {
      throw new Error(`Could not locate SPA route [${page.route}] callsite.`);
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
      `Could not resolve component [${local}] for SPA route [${page.route}]. Export it from the route file or import it with a standard ES import.`,
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

  private generateEntry(componentImport: ComponentImport) {
    const componentImportLine =
      componentImport.kind === "default"
        ? `import Component from "${componentImport.specifier}";`
        : componentImport.kind === "named"
          ? `import { ${componentImport.imported} as Component } from "${componentImport.specifier}";`
          : `import { ${componentImport.local} as Component } from "${componentImport.specifier}";`;

    return `import React from "react";
import { createRoot } from "react-dom/client";
${componentImportLine}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(React.createElement(Component));
}
`;
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

  private safeRouteName(route: string) {
    return route === "/" ? "root" : route.replaceAll("/", "_").replace(/[^A-Za-z0-9_-]/g, "_");
  }
}
