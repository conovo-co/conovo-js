import Decimal from "decimal.js";

/**
 * Value model for the expression engine (docs/EXPRESSIONS.md).
 * All arithmetic is decimal-safe: binary floats never touch money.
 * Banker's rounding (ROUND_HALF_EVEN) is the engine-wide default.
 */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export type DurationUnit = "days" | "weeks" | "months" | "years";

export type Value =
  | { kind: "number"; value: Decimal }
  | { kind: "money"; amount: Decimal; currency: string }
  | { kind: "date"; iso: string } // YYYY-MM-DD
  | { kind: "duration"; n: number; unit: DurationUnit }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "list"; items: Value[] };

export const num = (v: Decimal.Value): Value => ({
  kind: "number",
  value: new Decimal(v),
});
export const money = (v: Decimal.Value, currency = "USD"): Value => ({
  kind: "money",
  amount: new Decimal(v),
  currency,
});
export const date = (iso: string): Value => ({ kind: "date", iso });
export const duration = (n: number, unit: DurationUnit): Value => ({
  kind: "duration",
  n,
  unit,
});
export const text = (value: string): Value => ({ kind: "text", value });
export const bool = (value: boolean): Value => ({ kind: "boolean", value });
export const list = (items: Value[]): Value => ({ kind: "list", items });

// ---------------------------------------------------------------------------
// Errors

export class ExpressionError extends Error {}

export class ParseError extends ExpressionError {
  constructor(
    message: string,
    public readonly position: number,
  ) {
    super(`${message} (at position ${position})`);
  }
}

export class TypeMismatchError extends ExpressionError {}

/** A referenced input has no value — the computed field is unresolved. */
export class UnresolvedError extends ExpressionError {
  constructor(public readonly keys: string[]) {
    super(`unresolved: ${keys.join(", ")}`);
  }
}

/** Division by zero ⇒ unresolved + validation issue (never NaN/Infinity). */
export class DivisionByZeroError extends ExpressionError {
  constructor() {
    super("division by zero");
  }
}

export class CycleError extends ExpressionError {
  constructor(public readonly cycle: string[]) {
    super(`circular formulas: ${cycle.join(" → ")}`);
  }
}

// ---------------------------------------------------------------------------
// Date helpers (local-time Dates, used consistently everywhere)

export function parseIsoDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new TypeMismatchError(`invalid date "${iso}" (expected YYYY-MM-DD)`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function toIsoDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Formatting

/** "$4,500.00" — minor-unit rounding happens here, at the formatting edge. */
export function formatMoney(amount: Decimal, currency: string): string {
  const neg = amount.isNegative();
  const fixed = amount.abs().toFixed(2); // ROUND_HALF_EVEN via global config
  const [intPart = "0", frac = "00"] = fixed.split(".");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${neg ? "-" : ""}${symbol}${grouped}.${frac}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function formatDateLong(iso: string): string {
  const d = parseIsoDate(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Display form of any value — used by concat() and UI previews. */
export function toDisplayString(v: Value): string {
  switch (v.kind) {
    case "number":
      return v.value.toString();
    case "money":
      return formatMoney(v.amount, v.currency);
    case "date":
      return formatDateLong(v.iso);
    case "duration":
      return `${v.n} ${v.n === 1 ? v.unit.slice(0, -1) : v.unit}`;
    case "text":
      return v.value;
    case "boolean":
      return v.value ? "true" : "false";
    case "list":
      return v.items.map(toDisplayString).join(", ");
  }
}
