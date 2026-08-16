import { z } from "zod/v4";
import type { FieldType } from "./fields.js";
import {
  Decimal,
  TypeMismatchError,
  parseIsoDate,
  type DurationUnit,
  type Value,
} from "./expressions/value.js";

/**
 * JSON codec for the expression engine's Value model (EXPRESSIONS.md).
 * Decimals serialize as canonical strings so binary floats never touch money —
 * this is the shape stored in `fields.default_value`, `workspace_defaults.value`
 * and (Phase 2) `contracts.resolved_data`.
 */

/** Canonical decimal string: no exponent, no grouping. */
const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "expected a decimal number");
const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const durationUnitSchema = z.enum(["days", "weeks", "months", "years"]);

export type SerializedValue =
  | { kind: "number"; value: string }
  | { kind: "money"; amount: string; currency: string }
  | { kind: "date"; iso: string }
  | { kind: "duration"; n: number; unit: DurationUnit }
  | { kind: "text"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "list"; items: SerializedValue[] };

export const serializedValueSchema: z.ZodType<SerializedValue> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("number"), value: decimalString }),
    z.object({ kind: z.literal("money"), amount: decimalString, currency: z.string().min(1) }),
    z.object({ kind: z.literal("date"), iso: isoDateString }),
    z.object({
      kind: z.literal("duration"),
      n: z.number().int().nonnegative(),
      unit: durationUnitSchema,
    }),
    z.object({ kind: z.literal("text"), value: z.string() }),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }),
    z.object({ kind: z.literal("list"), items: z.array(serializedValueSchema) }),
  ]),
);

export function serializeValue(v: Value): SerializedValue {
  switch (v.kind) {
    case "number":
      return { kind: "number", value: v.value.toFixed() };
    case "money":
      return { kind: "money", amount: v.amount.toFixed(), currency: v.currency };
    case "list":
      return { kind: "list", items: v.items.map(serializeValue) };
    default:
      return v;
  }
}

export function deserializeValue(s: SerializedValue): Value {
  switch (s.kind) {
    case "number":
      return { kind: "number", value: new Decimal(s.value) };
    case "money":
      return { kind: "money", amount: new Decimal(s.amount), currency: s.currency };
    case "list":
      return { kind: "list", items: s.items.map(deserializeValue) };
    default:
      return s;
  }
}

// ---------------------------------------------------------------------------
// Typed user input → Value

/**
 * The Value kind a field of this type holds, or null when the type has no
 * simple scalar value (party/repeating_group/exhibit carry structured config
 * instead — they can't take a workspace default or per-deal scalar).
 */
export function valueKindForType(type: FieldType): Value["kind"] | null {
  switch (type) {
    case "money":
      return "money";
    case "number":
      return "number";
    case "date":
      return "date";
    case "duration":
      return "duration";
    case "text":
    case "long_text":
    case "name":
    case "address":
    case "choice":
      return "text";
    case "party":
    case "repeating_group":
    case "exhibit":
      return null;
  }
}

const MONEY_RE = /^\$?\s*(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)$/;
const NUMBER_RE = /^(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)%?$/;
const DURATION_RE = /^(\d+)\s*(day|week|month|year)s?$/i;

/** "March 3, 2026" — the inverse of formatDateLong (English month names only). */
const LONG_DATE_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})$/i;
const MONTH_INDEX: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseDateInput(input: string): Value {
  const long = LONG_DATE_RE.exec(input);
  if (long) {
    const mm = String(MONTH_INDEX[long[1]!.toLowerCase()]).padStart(2, "0");
    const dd = long[2]!.padStart(2, "0");
    return { kind: "date", iso: `${long[3]}-${mm}-${dd}` };
  }
  parseIsoDate(input); // throws with a clear message on bad input
  return { kind: "date", iso: input };
}

/**
 * Parse what a user typed into a field-typed Value. Deterministic, no locale
 * guessing: dates are YYYY-MM-DD or the long form we ourselves render
 * ("March 3, 2026"); money accepts an optional $ and thousands commas.
 * Throws TypeMismatchError with a plain-English message suitable for inline
 * display.
 */
export function parseValueInput(type: FieldType, raw: string): Value {
  const input = raw.trim();
  if (!input) throw new TypeMismatchError("enter a value");

  switch (valueKindForType(type)) {
    case "money": {
      const m = MONEY_RE.exec(input);
      if (!m) throw new TypeMismatchError(`"${input}" isn't an amount — try 4,500.00`);
      return { kind: "money", amount: new Decimal(m[1]!.replace(/,/g, "")), currency: "USD" };
    }
    case "number": {
      const m = NUMBER_RE.exec(input);
      if (!m) throw new TypeMismatchError(`"${input}" isn't a number`);
      const n = new Decimal(m[1]!.replace(/,/g, ""));
      return { kind: "number", value: input.endsWith("%") ? n.div(100) : n };
    }
    case "date":
      return parseDateInput(input);
    case "duration": {
      const m = DURATION_RE.exec(input);
      if (!m)
        throw new TypeMismatchError(`"${input}" isn't a duration — try "30 days"`);
      const unit = `${m[2]!.toLowerCase()}s` as DurationUnit;
      return { kind: "duration", n: Number(m[1]), unit };
    }
    case "text":
      return { kind: "text", value: input };
    default:
      throw new TypeMismatchError(`a ${type.replace("_", " ")} field can't take a simple value`);
  }
}

/**
 * Coerce a raw JSON value from the platform payload into a field-typed Value —
 * the resolver's entry point for platform_bound fields. Payload numbers are
 * taken as major units (dollars, not cents); platforms that store cents
 * convert in their payload builder. Throws TypeMismatchError when the payload
 * value can't honestly become this type (the field then falls through to
 * ask-me-at-send, SPEC §3.3).
 */
export function coercePayloadValue(type: FieldType, raw: unknown): Value {
  if (raw === null || raw === undefined)
    throw new TypeMismatchError("no value in payload");

  switch (valueKindForType(type)) {
    case "money": {
      if (typeof raw === "number" && Number.isFinite(raw))
        return { kind: "money", amount: new Decimal(raw), currency: "USD" };
      if (typeof raw === "string") return parseValueInput(type, raw);
      throw new TypeMismatchError(`payload value isn't an amount`);
    }
    case "number": {
      if (typeof raw === "number" && Number.isFinite(raw))
        return { kind: "number", value: new Decimal(raw) };
      if (typeof raw === "string") return parseValueInput(type, raw);
      throw new TypeMismatchError(`payload value isn't a number`);
    }
    case "date": {
      if (typeof raw === "string") return parseDateInput(raw.trim());
      throw new TypeMismatchError(`payload value isn't a date`);
    }
    case "duration": {
      if (typeof raw === "string") return parseValueInput(type, raw);
      throw new TypeMismatchError(`payload value isn't a duration`);
    }
    case "text": {
      if (typeof raw === "string") return { kind: "text", value: raw };
      if (typeof raw === "number" || typeof raw === "boolean")
        return { kind: "text", value: String(raw) };
      throw new TypeMismatchError(`payload value isn't text`);
    }
    default:
      throw new TypeMismatchError(
        `a ${type.replace("_", " ")} field can't bind to a scalar payload value`,
      );
  }
}
