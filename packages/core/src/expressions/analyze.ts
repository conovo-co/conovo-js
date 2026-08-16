import type { Ast } from "./ast.js";
import { CycleError } from "./value.js";

export interface Refs {
  /** Bare field references (includes bare group refs like count(g)'s arg). */
  fields: Set<string>;
  /** Group names referenced via columns (g.col). */
  groups: Set<string>;
}

export function collectRefs(ast: Ast, into?: Refs): Refs {
  const refs: Refs = into ?? { fields: new Set(), groups: new Set() };
  switch (ast.t) {
    case "ref":
      if (ast.column !== undefined) refs.groups.add(ast.name);
      else refs.fields.add(ast.name);
      break;
    case "unary":
      collectRefs(ast.operand, refs);
      break;
    case "binary":
      collectRefs(ast.left, refs);
      collectRefs(ast.right, refs);
      break;
    case "call":
      for (const a of ast.args) collectRefs(a, refs);
      break;
    default:
      break;
  }
  return refs;
}

/** Every key this expression depends on (fields + groups). */
export function dependencies(ast: Ast): Set<string> {
  const { fields, groups } = collectRefs(ast);
  return new Set([...fields, ...groups]);
}

/**
 * Order computed fields so dependencies evaluate first (fee → deposit →
 * balance → fee_words). Cycles are a save-time error in the template editor —
 * throws CycleError with the cycle path for a plain-English message.
 */
export function topoSort(formulas: Record<string, Ast>): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(key: string): void {
    const s = state.get(key);
    if (s === "done") return;
    if (s === "visiting") {
      const start = stack.indexOf(key);
      throw new CycleError([...stack.slice(start), key]);
    }
    const ast = formulas[key];
    if (!ast) return; // plain input, not a formula — a leaf
    state.set(key, "visiting");
    stack.push(key);
    for (const dep of dependencies(ast)) visit(dep);
    stack.pop();
    state.set(key, "done");
    order.push(key);
  }

  for (const key of Object.keys(formulas)) visit(key);
  return order;
}
