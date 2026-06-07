import ts from "typescript";
import { validateRouteParamUsage } from "./route-validator";

export type BackendCompileResult = {
  clientFile: string;
  handlers: Array<{ id: string; modulePath: string }>;
};

type ExtractedHandler = {
  id: string;
  functionText: string;
};

export class BackendCompiler {
  constructor(private tmpDir: string) {}

  async compileComponentFile(sourceFile: string, route?: string, componentName?: string): Promise<BackendCompileResult> {
    const source = await Bun.file(sourceFile).text();
    if (route && componentName) {
      validateRouteParamUsage(sourceFile, source, route, componentName);
    }

    const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const extracted: ExtractedHandler[] = [];

    const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          isBackendHookIdentifier(node.expression)
        ) {
          const [idArg, handlerArg, optionsArg] = node.arguments;
          const hookName = node.expression.text;
          if (!idArg || !ts.isStringLiteral(idArg)) {
            throw new Error(`${hookName} in [${sourceFile}] needs a string literal id.`);
          }
          if (!handlerArg || (!ts.isArrowFunction(handlerArg) && !ts.isFunctionExpression(handlerArg))) {
            throw new Error(`${hookName}("${idArg.text}") in [${sourceFile}] needs an inline function.`);
          }

          extracted.push({
            id: idArg.text,
            functionText: handlerArg.getText(parsed),
          });

          return context.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            hookName === "useBackend" && optionsArg
              ? [idArg, ts.factory.createIdentifier("undefined"), optionsArg]
              : [idArg],
          );
        }

        return ts.visitEachChild(node, visit, context);
      };

      return (node) => ts.visitNode(node, visit) as ts.SourceFile;
    };

    const transformed = ts.transform(parsed, [transformer]).transformed[0];
    if (!transformed) {
      throw new Error(`Failed to transform backend calls in [${sourceFile}].`);
    }

    const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
    const transformedSource = await this.resolveImportLines(
      sourceFile,
      removeUnusedImports(printer.printFile(transformed)),
    );
    const clientFile = `${this.tmpDir}\\${safeFileName(sourceFile)}-client.tsx`;
    await Bun.write(clientFile, transformedSource);

    const modulePath = `${this.tmpDir}\\${safeFileName(sourceFile)}-backend.ts`;
    if (extracted.length > 0) {
      await Bun.write(modulePath, await this.generateServerModule(sourceFile, source, extracted));
    }

    return {
      clientFile,
      handlers: extracted.map((handler) => ({ id: handler.id, modulePath })),
    };
  }

  private async generateServerModule(sourceFile: string, source: string, handlers: ExtractedHandler[]) {
    const imports = (
      await Promise.all(
        source
          .split(/\r?\n/)
          .filter((line) => line.trimStart().startsWith("import "))
          .map((line) => this.resolveImportLine(sourceFile, line)),
      )
    ).join("\n");
    const handlerEntries = handlers
      .map(
        (handler, index) => `const handler${index} = ${handler.functionText};
handlers.push({ id: ${JSON.stringify(handler.id)}, handler: handler${index} });`,
      )
      .join("\n\n");

    return `${imports}
import type { BackendRuntimeHandler } from "../src/backend";

export const handlers: BackendRuntimeHandler[] = [];

${handlerEntries}
`;
  }

  private async resolveImportLine(sourceFile: string, line: string) {
    const match = line.match(/from\s+["']([^"']+)["']/);
    const specifier = match?.[1];
    if (!specifier || (!specifier.startsWith(".") && !specifier.startsWith("/"))) return line;

    const resolved = this.importPath(await this.resolveImport(sourceFile, specifier));
    return line.replace(/from\s+["'][^"']+["']/, `from "${resolved}"`);
  }

  private async resolveImportLines(sourceFile: string, source: string) {
    const lines = await Promise.all(
      source.split("\n").map((line) => {
        if (!line.trimStart().startsWith("import ")) return line;
        return this.resolveImportLine(sourceFile, line);
      }),
    );

    return lines.join("\n");
  }

  private async resolveImport(importer: string, specifier: string) {
    const importerDir = importer.replace(/[\\/][^\\/]+$/, "");
    const unresolved = specifier.startsWith("/")
      ? specifier
      : `${importerDir}\\${specifier}`.replaceAll("/", "\\");

    return this.resolveExistingPath(unresolved);
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
}

function isBackendHookIdentifier(expression: ts.Identifier) {
  return expression.text === "useBackend" || expression.text === "useMutationBackend";
}

function removeUnusedImports(source: string) {
  return source
    .split("\n")
    .filter((line) => {
      const named = line.match(/^import\s+\{([^}]+)\}\s+from\s+["'][^"']+["'];?$/);
      if (!named) return true;

      const names = named[1]
        ?.split(",")
        .map((part) => part.trim().split(/\s+as\s+/).at(-1)?.trim())
        .filter(Boolean) as string[];

      return names.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source.replace(line, "")));
    })
    .join("\n");
}

function safeFileName(file: string) {
  return file.replace(/^[A-Za-z]:/, "").replace(/[\\/.:]/g, "_").replace(/[^A-Za-z0-9_-]/g, "_");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
