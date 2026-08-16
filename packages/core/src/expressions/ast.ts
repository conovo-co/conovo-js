import type { DurationUnit } from "./value.js";

/** AST for the expression language (docs/EXPRESSIONS.md grammar). */

export type BinOp =
  | "+" | "-" | "*" | "/"
  | "=" | "!=" | "<" | "<=" | ">" | ">="
  | "and" | "or";

export type Ast =
  | { t: "num"; value: string; percent: boolean }
  | { t: "money"; value: string; currency: string }
  | { t: "text"; value: string }
  | { t: "bool"; value: boolean }
  | { t: "duration"; n: number; unit: DurationUnit }
  | { t: "ref"; name: string; column?: string }
  | { t: "unary"; op: "-" | "not"; operand: Ast }
  | { t: "binary"; op: BinOp; left: Ast; right: Ast }
  | { t: "call"; name: string; args: Ast[] };

/**
 * Canonical string form. Fully parenthesizes compound expressions, so
 * parse(print(ast)) is always well-defined regardless of precedence.
 */
export function printExpression(ast: Ast): string {
  switch (ast.t) {
    case "num":
      return ast.percent ? `${ast.value}%` : ast.value;
    case "money":
      return `$${ast.value}`;
    case "text":
      return JSON.stringify(ast.value);
    case "bool":
      return ast.value ? "true" : "false";
    case "duration":
      return `${ast.n} ${ast.unit}`;
    case "ref":
      return ast.column === undefined ? ast.name : `${ast.name}.${ast.column}`;
    case "unary":
      return ast.op === "not"
        ? `not ${wrap(ast.operand)}`
        : `-${wrap(ast.operand)}`;
    case "binary":
      return `${wrap(ast.left)} ${ast.op} ${wrap(ast.right)}`;
    case "call":
      return `${ast.name}(${ast.args.map(printExpression).join(", ")})`;
  }
}

function wrap(ast: Ast): string {
  const s = printExpression(ast);
  return ast.t === "binary" || ast.t === "unary" ? `(${s})` : s;
}
