import {
  coercePayloadValue,
  deserializeValue,
  evaluateFormulas,
  parseExpression,
  parseValueInput,
  resolvePath,
  serializeValue,
  toDisplayString,
  toIsoDate,
  CycleError,
  ExpressionError,
  type FieldSource,
  type FieldType,
  type SerializedValue,
  type Value,
} from "@conovo/core";

/** Human display of a stored value ("$4,500.00", "March 3, 2026"). */
export function displayValue(v: SerializedValue): string {
  return toDisplayString(deserializeValue(v));
}

/**
 * The editable text form of a stored value — must round-trip through
 * `parseValueInput` (so dates stay ISO, unlike their display form).
 */
export function editStringForValue(v: SerializedValue): string {
  switch (v.kind) {
    case "money":
      return `$${v.amount}`;
    case "number":
      return v.value;
    case "date":
      return v.iso;
    case "duration":
      return `${v.n} ${v.unit}`;
    case "text":
      return v.value;
    default:
      return "";
  }
}

/** Parse user input for a field type; returns a value or an inline error. */
export function tryParseInput(
  type: FieldType,
  raw: string,
): { value: SerializedValue } | { error: string } {
  try {
    return { value: serializeValue(parseValueInput(type, raw)) };
  } catch (err) {
    if (err instanceof ExpressionError) return { error: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Formula live preview

export interface PreviewInput {
  key: string;
  type: FieldType;
  source: FieldSource;
  accepted: boolean;
  binding?: { path: string; accepted: boolean };
  expression?: string;
  defaultRaw?: string;
  occurrences: { snippet: string }[];
}

export type FormulaPreview = { ok: string } | { error: string };

/**
 * Evaluate every accepted computed field against sample values drawn from the
 * document being reviewed: bound fields use the registered sample payload,
 * standing values use what the user typed, everything else uses the value's
 * own text in the uploaded contract. Preview only — the send path re-resolves
 * from scratch in pure code.
 */
export function computeFormulaPreviews(
  fields: PreviewInput[],
  samplePayload: unknown,
): Record<string, FormulaPreview> {
  const ctxFields: Record<string, Value> = {};
  const formulas: Record<string, string> = {};
  const out: Record<string, FormulaPreview> = {};

  for (const f of fields) {
    if (!f.accepted) continue;
    if (f.source === "computed") {
      if (f.expression?.trim()) formulas[f.key] = f.expression;
      continue;
    }
    try {
      if (f.source === "platform_bound" && f.binding?.accepted) {
        ctxFields[f.key] = coercePayloadValue(
          f.type,
          resolvePath(samplePayload, f.binding.path),
        );
      } else if (f.source === "workspace_default") {
        if (f.defaultRaw?.trim())
          ctxFields[f.key] = parseValueInput(f.type, f.defaultRaw);
      } else {
        const snippet = f.occurrences[0]?.snippet;
        if (snippet) ctxFields[f.key] = parseValueInput(f.type, snippet);
      }
    } catch {
      // No usable sample value — formulas referencing it show as "waiting on".
    }
  }

  // Parse each formula on its own so one typo doesn't kill the whole preview.
  const parsable: Record<string, string> = {};
  for (const [key, src] of Object.entries(formulas)) {
    try {
      parseExpression(src);
      parsable[key] = src;
    } catch (err) {
      out[key] = {
        error: err instanceof ExpressionError ? err.message : "doesn't parse",
      };
    }
  }

  const today = toIsoDate(new Date());
  try {
    const res = evaluateFormulas(parsable, {
      fields: ctxFields,
      sentDate: today,
      today,
    });
    for (const [key, v] of Object.entries(res.values))
      out[key] = { ok: toDisplayString(v) };
    for (const [key, missing] of Object.entries(res.unresolved))
      out[key] = { error: `waiting on: ${missing.join(", ")}` };
    for (const [key, msg] of Object.entries(res.errors)) out[key] = { error: msg };
  } catch (err) {
    if (!(err instanceof CycleError)) throw err;
    for (const key of Object.keys(parsable))
      if (err.cycle.includes(key))
        out[key] = { error: `circular: ${err.cycle.join(" → ")}` };
  }
  return out;
}

/**
 * What a binding actually produces from the platform's sample payload.
 *
 * The review UI used to show only the PATH ("customer.address.city"), which
 * is exactly the wrong altitude for catching a mis-map: the path always looks
 * plausible, the value it lands on is what gives it away. Deterministic —
 * the same coercion the resolver runs at send time.
 */
export function bindingPreview(
  type: FieldType,
  path: string,
  samplePayload: unknown,
): string | null {
  try {
    const raw = resolvePath(samplePayload, path);
    if (raw === undefined || raw === null) return null;
    return toDisplayString(coercePayloadValue(type, raw));
  } catch {
    return null;
  }
}
