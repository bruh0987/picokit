import ts from "typescript";
import { getRouteParamNames, normalizeRoute } from "./router";

export function validateRouteParamUsage(
  sourceFile: string,
  source: string,
  route: string,
  componentName: string,
) {
  const parsed = ts.createSourceFile(sourceFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const availableParams = new Set(getRouteParamNames(route));
  const routeVariables = new Set<string>();
  const usedParams = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "useRoute"
    ) {
      routeVariables.add(node.name.text);
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "params" &&
      ts.isIdentifier(node.expression.expression) &&
      routeVariables.has(node.expression.expression.text)
    ) {
      usedParams.add(node.name.text);
    }

    ts.forEachChild(node, visit);
  };

  const componentNode = findComponentNode(parsed, componentName);
  if (!componentNode) return;

  visit(componentNode);

  const missing = [...usedParams].filter((param) => !availableParams.has(param));
  if (missing.length === 0) return;

  const available = [...availableParams].join(", ") || "none";
  throw new Error(
    `Route [${normalizeRoute(route)}] renders [${sourceFile}], but it reads missing route param(s): ${missing.join(", ")}. Available params: ${available}.`,
  );
}

function findComponentNode(sourceFile: ts.SourceFile, componentName: string) {
  let found: ts.Node | undefined;

  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === componentName
    ) {
      found = node;
      return;
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === componentName &&
      node.initializer
    ) {
      found = node.initializer;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}
