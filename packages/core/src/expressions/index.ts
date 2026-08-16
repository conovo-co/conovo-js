import type { Ast } from "./ast.js";
import { topoSort } from "./analyze.js";
import { evaluateExpression, type EvalContext } from "./evaluate.js";
import { parseExpression } from "./parser.js";
import { ExpressionError, UnresolvedError, type Value } from "./value.js";

export * from "./value.js";
export { printExpression, type Ast, type BinOp } from "./ast.js";
export { parseExpression } from "./parser.js";
export { collectRefs, dependencies, topoSort, type Refs } from "./analyze.js";
export { evaluateExpression, type EvalContext } from "./evaluate.js";
export { numberToWords, spellOutMoney } from "./spellOut.js";

export interface FormulaEvaluation {
  /** Successfully computed values, keyed by field. */
  values: Record<string, Value>;
  /** Fields that could not resolve, with the missing input keys. */
  unresolved: Record<string, string[]>;
  /** Fields whose formula errored (type mismatch, division by zero, …). */
  errors: Record<string, string>;
  /** Dependency evaluation order used. */
  order: string[];
}

/**
 * Evaluate a template's computed fields in dependency order (fee → deposit →
 * balance → fee_words). Unresolved inputs propagate: a field is skipped, its
 * dependents become unresolved too — never silently coerced (EXPRESSIONS.md).
 * Throws CycleError (a save-time template error) and ParseError only.
 */
export function evaluateFormulas(
  formulas: Record<string, string | Ast>,
  ctx: EvalContext,
): FormulaEvaluation {
  const asts: Record<string, Ast> = {};
  for (const [key, f] of Object.entries(formulas)) {
    asts[key] = typeof f === "string" ? parseExpression(f) : f;
  }

  const order = topoSort(asts);
  const fields: Record<string, Value> = { ...ctx.fields };
  const result: FormulaEvaluation = { values: {}, unresolved: {}, errors: {}, order };

  for (const key of order) {
    const ast = asts[key];
    if (!ast) continue;
    try {
      const v = evaluateExpression(ast, { ...ctx, fields });
      result.values[key] = v;
      fields[key] = v;
    } catch (err) {
      if (err instanceof UnresolvedError) {
        result.unresolved[key] = err.keys;
      } else if (err instanceof ExpressionError) {
        result.errors[key] = err.message;
      } else {
        throw err;
      }
    }
  }

  return result;
}
