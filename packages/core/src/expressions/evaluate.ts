import { addDays, addMonths, addWeeks, differenceInCalendarDays } from "date-fns";
import type { Ast } from "./ast.js";
import { spellOutMoney } from "./spellOut.js";
import {
  bool,
  date,
  Decimal,
  DivisionByZeroError,
  formatMoney,
  formatDateLong,
  list,
  money,
  num,
  parseIsoDate,
  text,
  toDisplayString,
  toIsoDate,
  TypeMismatchError,
  UnresolvedError,
  type Value,
} from "./value.js";

/**
 * Deterministic evaluator (docs/EXPRESSIONS.md). Pure: same AST + context →
 * same value, forever. `today`/`sentDate` are supplied by the caller and
 * recorded in resolved_data so stored contracts reproduce identically.
 */
export interface EvalContext {
  fields: Record<string, Value>;
  groups?: Record<string, Array<Record<string, Value>>>;
  /** ISO date the contract is generated/sent. */
  sentDate: string;
  /** ISO date "today" (usually === sentDate). */
  today: string;
}

export function evaluateExpression(ast: Ast, ctx: EvalContext): Value {
  return ev(ast, ctx);
}

// ---------------------------------------------------------------------------

function ev(ast: Ast, ctx: EvalContext): Value {
  switch (ast.t) {
    case "num": {
      const d = new Decimal(ast.value);
      return num(ast.percent ? d.div(100) : d);
    }
    case "money":
      return money(ast.value, ast.currency);
    case "text":
      return text(ast.value);
    case "bool":
      return bool(ast.value);
    case "duration":
      return { kind: "duration", n: ast.n, unit: ast.unit };
    case "ref":
      return evalRef(ast, ctx);
    case "unary": {
      if (ast.op === "not") {
        const v = ev(ast.operand, ctx);
        if (v.kind !== "boolean")
          throw new TypeMismatchError(`not expects a condition, got ${v.kind}`);
        return bool(!v.value);
      }
      const v = ev(ast.operand, ctx);
      if (v.kind === "number") return num(v.value.neg());
      if (v.kind === "money") return money(v.amount.neg(), v.currency);
      throw new TypeMismatchError(`cannot negate ${v.kind}`);
    }
    case "binary":
      return evalBinary(ast.op, ast.left, ast.right, ctx);
    case "call":
      return evalCall(ast.name, ast.args, ctx);
  }
}

function evalRef(ast: { name: string; column?: string }, ctx: EvalContext): Value {
  if (ast.column !== undefined) {
    const rows = ctx.groups?.[ast.name];
    if (!rows) throw new UnresolvedError([ast.name]);
    return list(
      rows.map((row, i) => {
        const v = row[ast.column!];
        if (!v) throw new UnresolvedError([`${ast.name}[${i}].${ast.column}`]);
        return v;
      }),
    );
  }
  const v = ctx.fields[ast.name];
  if (!v) throw new UnresolvedError([ast.name]);
  return v;
}

// ---------------------------------------------------------------------------
// Operators

function evalBinary(op: string, leftAst: Ast, rightAst: Ast, ctx: EvalContext): Value {
  // short-circuit booleans
  if (op === "and" || op === "or") {
    const l = ev(leftAst, ctx);
    if (l.kind !== "boolean")
      throw new TypeMismatchError(`${op} expects conditions, got ${l.kind}`);
    if (op === "and" && !l.value) return bool(false);
    if (op === "or" && l.value) return bool(true);
    const r = ev(rightAst, ctx);
    if (r.kind !== "boolean")
      throw new TypeMismatchError(`${op} expects conditions, got ${r.kind}`);
    return bool(r.value);
  }

  const l = ev(leftAst, ctx);
  const r = ev(rightAst, ctx);

  switch (op) {
    case "+":
    case "-": {
      if (l.kind === "number" && r.kind === "number")
        return num(op === "+" ? l.value.plus(r.value) : l.value.minus(r.value));
      if (l.kind === "money" && r.kind === "money") {
        requireSameCurrency(l, r, op);
        return money(
          op === "+" ? l.amount.plus(r.amount) : l.amount.minus(r.amount),
          l.currency,
        );
      }
      throw new TypeMismatchError(`cannot ${op === "+" ? "add" : "subtract"} ${l.kind} and ${r.kind}`);
    }
    case "*": {
      if (l.kind === "number" && r.kind === "number") return num(l.value.times(r.value));
      if (l.kind === "money" && r.kind === "number")
        return money(l.amount.times(r.value), l.currency);
      if (l.kind === "number" && r.kind === "money")
        return money(r.amount.times(l.value), r.currency);
      // money × money is a type error by spec
      throw new TypeMismatchError(`cannot multiply ${l.kind} and ${r.kind}`);
    }
    case "/": {
      if (r.kind === "number") {
        if (r.value.isZero()) throw new DivisionByZeroError();
        if (l.kind === "number") return num(l.value.div(r.value));
        if (l.kind === "money") return money(l.amount.div(r.value), l.currency);
      }
      if (l.kind === "money" && r.kind === "money") {
        requireSameCurrency(l, r, "/");
        if (r.amount.isZero()) throw new DivisionByZeroError();
        return num(l.amount.div(r.amount)); // ratio
      }
      throw new TypeMismatchError(`cannot divide ${l.kind} by ${r.kind}`);
    }
    default:
      return evalComparison(op, l, r);
  }
}

function requireSameCurrency(
  l: { currency: string },
  r: { currency: string },
  op: string,
): void {
  if (l.currency !== r.currency)
    throw new TypeMismatchError(
      `currency mismatch: ${l.currency} ${op} ${r.currency}`,
    );
}

function evalComparison(op: string, l: Value, r: Value): Value {
  const cmp = compare(l, r);
  switch (op) {
    case "=":
      return bool(cmp === 0);
    case "!=":
      return bool(cmp !== 0);
    case "<":
      return bool(cmp < 0);
    case "<=":
      return bool(cmp <= 0);
    case ">":
      return bool(cmp > 0);
    case ">=":
      return bool(cmp >= 0);
    default:
      throw new TypeMismatchError(`unknown operator ${op}`);
  }
}

/** Total order within comparable kinds; cross-kind comparison is an error. */
function compare(l: Value, r: Value): number {
  if (l.kind === "number" && r.kind === "number") return l.value.comparedTo(r.value);
  if (l.kind === "money" && r.kind === "money") {
    requireSameCurrency(l, r, "compare");
    return l.amount.comparedTo(r.amount);
  }
  if (l.kind === "date" && r.kind === "date")
    return l.iso < r.iso ? -1 : l.iso > r.iso ? 1 : 0;
  if (l.kind === "text" && r.kind === "text")
    return l.value < r.value ? -1 : l.value > r.value ? 1 : 0;
  if (l.kind === "boolean" && r.kind === "boolean")
    return Number(l.value) - Number(r.value);
  throw new TypeMismatchError(`cannot compare ${l.kind} with ${r.kind}`);
}

// ---------------------------------------------------------------------------
// Function library (the COMPLETE set — additions need an ADR)

function evalCall(name: string, args: Ast[], ctx: EvalContext): Value {
  switch (name) {
    case "if": {
      arity(name, args, 3);
      const cond = ev(args[0]!, ctx);
      if (cond.kind !== "boolean")
        throw new TypeMismatchError("if() condition must be true/false");
      return ev(cond.value ? args[1]! : args[2]!, ctx); // lazy branches
    }

    case "sum": {
      arity(name, args, 1);
      const items = asList(ev(args[0]!, ctx), name);
      if (items.length === 0) return num(0);
      return items.reduce((acc, v) =>
        evalBinaryValues("+", acc, v),
      );
    }
    case "min":
    case "max": {
      arity(name, args, 1);
      const items = asList(ev(args[0]!, ctx), name);
      if (items.length === 0)
        throw new TypeMismatchError(`${name}() of an empty list`);
      return items.reduce((best, v) =>
        (name === "min" ? compare(v, best) < 0 : compare(v, best) > 0) ? v : best,
      );
    }
    case "avg": {
      arity(name, args, 1);
      const items = asList(ev(args[0]!, ctx), name);
      if (items.length === 0)
        throw new TypeMismatchError("avg() of an empty list");
      const total = items.reduce((acc, v) => evalBinaryValues("+", acc, v));
      if (total.kind === "number") return num(total.value.div(items.length));
      if (total.kind === "money")
        return money(total.amount.div(items.length), total.currency);
      throw new TypeMismatchError("avg() expects numbers or money");
    }
    case "count": {
      arity(name, args, 1);
      const arg = args[0]!;
      // count(g) — bare group ref counts rows
      if (arg.t === "ref" && arg.column === undefined) {
        const rows = ctx.groups?.[arg.name];
        if (rows) return num(rows.length);
      }
      return num(asList(ev(arg, ctx), name).length);
    }

    case "round": {
      arityBetween(name, args, 1, 2);
      const v = ev(args[0]!, ctx);
      const places = args[1] ? asInt(ev(args[1]!, ctx), "round places") : 0;
      if (v.kind === "number")
        return num(v.value.toDecimalPlaces(places, Decimal.ROUND_HALF_EVEN));
      if (v.kind === "money")
        return money(v.amount.toDecimalPlaces(places, Decimal.ROUND_HALF_EVEN), v.currency);
      throw new TypeMismatchError("round() expects a number or money");
    }
    case "abs": {
      arity(name, args, 1);
      const v = ev(args[0]!, ctx);
      if (v.kind === "number") return num(v.value.abs());
      if (v.kind === "money") return money(v.amount.abs(), v.currency);
      throw new TypeMismatchError("abs() expects a number or money");
    }

    case "addDays":
    case "addWeeks":
    case "addMonths": {
      arity(name, args, 2);
      const d = asDate(ev(args[0]!, ctx), name);
      const n = asInt(ev(args[1]!, ctx), `${name} count`);
      const base = parseIsoDate(d);
      const out =
        name === "addDays" ? addDays(base, n)
        : name === "addWeeks" ? addWeeks(base, n)
        : addMonths(base, n);
      return date(toIsoDate(out));
    }
    case "businessDays": {
      arity(name, args, 2);
      const d = asDate(ev(args[0]!, ctx), name);
      let n = asInt(ev(args[1]!, ctx), "businessDays count");
      let cur = parseIsoDate(d);
      const step = n >= 0 ? 1 : -1;
      n = Math.abs(n);
      while (n > 0) {
        cur = addDays(cur, step);
        const day = cur.getDay();
        if (day !== 0 && day !== 6) n--;
      }
      return date(toIsoDate(cur));
    }
    case "daysBetween": {
      arity(name, args, 2);
      const a = asDate(ev(args[0]!, ctx), name);
      const b = asDate(ev(args[1]!, ctx), name);
      return num(differenceInCalendarDays(parseIsoDate(b), parseIsoDate(a)));
    }
    case "today":
      arity(name, args, 0);
      return date(ctx.today);
    case "sentDate":
      arity(name, args, 0);
      return date(ctx.sentDate);
    case "expiry": {
      arity(name, args, 1);
      const n = asInt(ev(args[0]!, ctx), "expiry days");
      return date(toIsoDate(addDays(parseIsoDate(ctx.sentDate), n)));
    }

    case "spellOut": {
      arity(name, args, 1);
      const v = ev(args[0]!, ctx);
      if (v.kind !== "money")
        throw new TypeMismatchError("spellOut() expects money");
      return text(spellOutMoney(v.amount, v.currency));
    }
    case "pluralize": {
      arity(name, args, 2);
      const n = ev(args[0]!, ctx);
      const unit = ev(args[1]!, ctx);
      if (n.kind !== "number" || unit.kind !== "text")
        throw new TypeMismatchError('pluralize() expects (number, "unit")');
      const one = n.value.eq(1);
      return text(`${n.value.toString()} ${unit.value}${one ? "" : "s"}`);
    }
    case "formatDate": {
      arityBetween(name, args, 1, 2);
      const d = asDate(ev(args[0]!, ctx), name);
      const styleV = args[1] ? ev(args[1]!, ctx) : text("long");
      if (styleV.kind !== "text")
        throw new TypeMismatchError("formatDate() style must be text");
      switch (styleV.value) {
        case "long":
          return text(formatDateLong(d));
        case "iso":
          return text(d);
        case "short": {
          const [y, m, day] = d.split("-");
          return text(`${m}/${day}/${y}`);
        }
        default:
          throw new TypeMismatchError(
            `formatDate() style must be "long", "short" or "iso"`,
          );
      }
    }
    case "concat": {
      const parts = args.map((a) => toDisplayString(ev(a, ctx)));
      return text(parts.join(""));
    }

    case "split": {
      arity(name, args, 2);
      const total = ev(args[0]!, ctx);
      const n = asInt(ev(args[1]!, ctx), "split count");
      if (total.kind !== "money")
        throw new TypeMismatchError("split() expects (money, count)");
      if (n <= 0) throw new TypeMismatchError("split() count must be positive");
      // exact: work in integer minor units; remainder cents to the FIRST share
      const cents = total.amount
        .times(100)
        .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
      const per = cents.divToInt(n);
      const remainder = cents.minus(per.times(n));
      const shares: Value[] = [];
      for (let i = 0; i < n; i++) {
        const share = i === 0 ? per.plus(remainder) : per;
        shares.push(money(share.div(100), total.currency));
      }
      return list(shares);
    }

    default:
      throw new TypeMismatchError(`unknown function ${name}()`);
  }
}

// value-level + for reduce (sum/avg)
function evalBinaryValues(op: "+", l: Value, r: Value): Value {
  if (l.kind === "number" && r.kind === "number") return num(l.value.plus(r.value));
  if (l.kind === "money" && r.kind === "money") {
    requireSameCurrency(l, r, op);
    return money(l.amount.plus(r.amount), l.currency);
  }
  throw new TypeMismatchError(`cannot add ${l.kind} and ${r.kind}`);
}

// ---------------------------------------------------------------------------
// Argument helpers

function arity(name: string, args: Ast[], n: number): void {
  if (args.length !== n)
    throw new TypeMismatchError(`${name}() expects ${n} argument${n === 1 ? "" : "s"}`);
}
function arityBetween(name: string, args: Ast[], min: number, max: number): void {
  if (args.length < min || args.length > max)
    throw new TypeMismatchError(`${name}() expects ${min}–${max} arguments`);
}
function asList(v: Value, fn: string): Value[] {
  if (v.kind !== "list") throw new TypeMismatchError(`${fn}() expects a list`);
  return v.items;
}
function asDate(v: Value, fn: string): string {
  if (v.kind !== "date") throw new TypeMismatchError(`${fn}() expects a date`);
  return v.iso;
}
function asInt(v: Value, what: string): number {
  if (v.kind !== "number" || !v.value.isInteger())
    throw new TypeMismatchError(`${what} must be a whole number`);
  return v.value.toNumber();
}

// re-export for formatMoney use in tests via this module's consumers
export { formatMoney };
