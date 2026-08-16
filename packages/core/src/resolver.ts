import type { FieldSource, FieldType } from "./fields.js";
import {
  conditionalSectionFieldConfigSchema,
  repeatingGroupFieldConfigSchema,
} from "./fields.js";
import {
  coercePayloadValue,
  deserializeValue,
  serializeValue,
  valueKindForType,
  type SerializedValue,
} from "./values.js";
import { resolvePath } from "./bindings.js";
import {
  evaluateFormulas,
  ExpressionError,
  type Value,
} from "./expressions/index.js";

/**
 * Send-time resolver (docs/SPEC.md §3.3). Pure and deterministic: same
 * template fields + same inputs → same resolved_data, forever. No I/O, no AI
 * (CLAUDE.md invariant 2) — the caller fetches payload/defaults/presets and
 * records `sentDate`.
 *
 * Per-field priority: platform payload → workspace default → preset →
 * computed → per-deal input. A miss at any step falls through; a fully
 * unresolved field surfaces in `unresolved` (ask-me-at-send). Payload misses
 * are recorded separately — they fuel the platform's payload gap report
 * (SPEC §3.8).
 */

export interface ResolverField {
  key: string;
  label: string;
  type: FieldType;
  source: FieldSource;
  bindingPath?: string | null;
  /** Version-pinned default captured at confirm (fallback when the live workspace default is gone). */
  defaultValue?: SerializedValue | null;
  expression?: string | null;
  config?: unknown;
  required: boolean;
}

export interface ResolveInputs {
  /** The platform's subject payload (render-time prop or connector fetch). */
  payload?: unknown;
  /** Live workspace defaults by field key. */
  workspaceDefaults?: Record<string, SerializedValue>;
  /** Selected preset's values by field key. */
  presetValues?: Record<string, SerializedValue>;
  /** What the user typed in the per-deal panel. */
  perDeal?: Record<string, SerializedValue>;
  /**
   * Explicit send-time edits to values that resolved automatically (SPEC §3.3).
   * Distinct from `perDeal`, which is the LAST resort for fields nothing else
   * filled; an override is a human correcting an automatic answer, so it wins
   * over payload, workspace default, preset, and a field's own formula.
   * Dependent formulas recompute from the edited value.
   */
  overrides?: Record<string, SerializedValue>;
  /** Rows for repeating_group fields, by field key. */
  groupRows?: Record<string, Array<Record<string, SerializedValue>>>;
  /** ISO date of this send — recorded in resolved_data for reproducibility. */
  sentDate: string;
}

export type Provenance =
  | "platform"
  | "workspace_default"
  | "preset"
  | "computed"
  /** Explicit human edit at send time — outranks every automatic source. */
  | "edited"
  | "per_deal";

export interface ResolvedField {
  value: SerializedValue;
  provenance: Provenance;
}

export interface PayloadMiss {
  key: string;
  bindingPath: string;
  /** "absent" — path missing from payload; "mismatch" — present but wrong shape. */
  reason: "absent" | "mismatch";
}

export interface UnresolvedField {
  key: string;
  label: string;
  required: boolean;
  reason: string;
}

/** The exact data stored on the contract (`contracts.resolved_data`). */
export interface ResolutionResult {
  sentDate: string;
  values: Record<string, ResolvedField>;
  /** Resolved repeating-group rows, cells coerced to column types. */
  groups: Record<string, Array<Record<string, SerializedValue>>>;
  unresolved: UnresolvedField[];
  payloadMisses: PayloadMiss[];
  /** party/exhibit fields — structured, resolved outside (recipients etc.). */
  structured: string[];
  /**
   * Conditional fields' evaluated conditions: true/false, or null when the
   * condition exists but couldn't produce a yes/no (missing inputs, non-
   * boolean result). Fields without an expression aren't listed. Sections
   * with false conditions are removed at fill; requiredness of conditional
   * blanks follows this map (SPEC §3.2).
   */
  conditions: Record<string, boolean | null>;
}

function scalarChainValue(
  field: ResolverField,
  inputs: ResolveInputs,
  misses: PayloadMiss[],
): { value: Value; provenance: Provenance } | null {
  // 1. Platform payload via binding.
  if (field.bindingPath && inputs.payload !== undefined) {
    const raw = resolvePath(inputs.payload, field.bindingPath);
    if (raw === undefined || raw === null) {
      misses.push({ key: field.key, bindingPath: field.bindingPath, reason: "absent" });
    } else {
      try {
        return { value: coercePayloadValue(field.type, raw), provenance: "platform" };
      } catch (err) {
        if (!(err instanceof ExpressionError)) throw err;
        misses.push({ key: field.key, bindingPath: field.bindingPath, reason: "mismatch" });
      }
    }
  }

  // 2. Workspace default (live value wins; version-pinned default is the fallback).
  const def = inputs.workspaceDefaults?.[field.key] ?? field.defaultValue;
  if (def) {
    const v = safeDeserialize(field.type, def);
    if (v) return { value: v, provenance: "workspace_default" };
  }

  // 3. Preset.
  const preset = inputs.presetValues?.[field.key];
  if (preset) {
    const v = safeDeserialize(field.type, preset);
    if (v) return { value: v, provenance: "preset" };
  }

  // 4. computed happens in the formula pass; 5. per-deal after it.
  return null;
}

/** Deserialize a stored value, refusing kind/type mismatches. */
function safeDeserialize(type: FieldType, sv: SerializedValue): Value | null {
  if (sv.kind !== valueKindForType(type)) return null;
  return deserializeValue(sv);
}

export function resolveFields(
  fields: ResolverField[],
  inputs: ResolveInputs,
): ResolutionResult {
  const values: Record<string, ResolvedField> = {};
  const resolved: Record<string, Value> = {};
  const payloadMisses: PayloadMiss[] = [];
  const unresolved: UnresolvedField[] = [];
  const structured: string[] = [];
  const groups: ResolutionResult["groups"] = {};
  const groupCtx: Record<string, Array<Record<string, Value>>> = {};

  const scalarFields = fields.filter(
    (f) => f.type !== "party" && f.type !== "exhibit" && f.type !== "repeating_group",
  );

  // Repeating groups: rows come from inputs, cells coerced to column types.
  for (const f of fields) {
    if (f.type === "repeating_group") {
      const cfg = repeatingGroupFieldConfigSchema.safeParse(f.config ?? {});
      const rows = inputs.groupRows?.[f.key];
      if (!cfg.success || !rows || rows.length === 0) {
        unresolved.push({
          key: f.key,
          label: f.label,
          required: f.required,
          reason: rows ? "no rows provided" : "enter the rows for this table",
        });
        continue;
      }
      const outRows: Array<Record<string, SerializedValue>> = [];
      const ctxRows: Array<Record<string, Value>> = [];
      for (const row of rows) {
        const out: Record<string, SerializedValue> = {};
        const ctx: Record<string, Value> = {};
        for (const col of cfg.data.columns) {
          const cell = row[col.key];
          const v = cell ? safeDeserialize(col.type, cell) : null;
          if (!v) continue; // validator flags incomplete rows
          out[col.key] = serializeValue(v);
          ctx[col.key] = v;
        }
        outRows.push(out);
        ctxRows.push(ctx);
      }
      groups[f.key] = outRows;
      groupCtx[f.key] = ctxRows;
    } else if (f.type === "party" || f.type === "exhibit") {
      structured.push(f.key);
    }
  }

  // Pass 0: explicit human edits. Applied before everything so they outrank
  // the automatic chain AND a field's own formula; later passes only fill keys
  // that are still open. Formulas that DEPEND on an edited field still
  // recompute from it (pass 3), which is the point of editing a total.
  for (const f of scalarFields) {
    const raw = inputs.overrides?.[f.key];
    const v = raw ? safeDeserialize(f.type, raw) : null;
    if (!v) continue;
    resolved[f.key] = v;
    values[f.key] = { value: serializeValue(v), provenance: "edited" };
  }

  // Pass 1: platform / workspace default / preset.
  for (const f of scalarFields) {
    if (f.key in resolved) continue; // edited above
    const hit = scalarChainValue(f, inputs, payloadMisses);
    if (hit) {
      resolved[f.key] = hit.value;
      values[f.key] = { value: serializeValue(hit.value), provenance: hit.provenance };
    }
  }

  // Pass 2: per-deal input for open NON-computed fields. Runs before the
  // formula pass so formulas can consume per-deal inputs (deposit computed
  // from a per-deal total fee); a field's own formula still outranks a
  // per-deal override of itself (SPEC §3.3 priority).
  const takePerDeal = (f: ResolverField): boolean => {
    const pd = inputs.perDeal?.[f.key];
    const v = pd ? safeDeserialize(f.type, pd) : null;
    if (!v) return false;
    resolved[f.key] = v;
    values[f.key] = { value: serializeValue(v), provenance: "per_deal" };
    return true;
  };
  for (const f of scalarFields) {
    // A conditional field's expression is its condition, not a value source —
    // per-deal input still fills the blank itself.
    if (!(f.key in resolved) && (!f.expression || f.source === "conditional"))
      takePerDeal(f);
  }

  // Pass 3: formulas, in dependency order, over everything resolved so far.
  // Conditional fields are excluded: their expression is a CONDITION (does
  // this section apply?), never a value — it evaluates separately below.
  const formulas: Record<string, string> = {};
  for (const f of scalarFields) {
    if (f.source === "conditional") continue;
    if (f.expression && !(f.key in resolved)) formulas[f.key] = f.expression;
  }
  // Throws CycleError/ParseError only — both are save-time template errors
  // (the confirm endpoint rejects them), so reaching one here is a bug.
  const evaluated = evaluateFormulas(formulas, {
    fields: resolved,
    groups: groupCtx,
    sentDate: inputs.sentDate,
    today: inputs.sentDate,
  });
  for (const [key, v] of Object.entries(evaluated.values)) {
    resolved[key] = v;
    values[key] = { value: serializeValue(v), provenance: "computed" };
  }

  // Conditions: each conditional field's expression evaluates to yes/no over
  // everything resolved so far. Results live in their own map — a condition
  // is never a document value (SPEC §3.2).
  const conditions: Record<string, boolean | null> = {};
  const conditionExprs: Record<string, string> = {};
  for (const f of scalarFields) {
    if (f.source === "conditional" && f.expression) conditionExprs[f.key] = f.expression;
  }
  if (Object.keys(conditionExprs).length > 0) {
    const evaluatedConditions = evaluateFormulas(conditionExprs, {
      fields: resolved,
      groups: groupCtx,
      sentDate: inputs.sentDate,
      today: inputs.sentDate,
    });
    for (const key of Object.keys(conditionExprs)) {
      const v = evaluatedConditions.values[key];
      conditions[key] = v && v.kind === "boolean" ? v.value : null;
    }
  }

  /** Section-only conditional fields aren't values — nothing to resolve. */
  const isSection = (f: ResolverField) =>
    f.source === "conditional" &&
    conditionalSectionFieldConfigSchema.safeParse(f.config ?? {}).success;

  // Pass 4: computed fields whose inputs were missing can still be supplied
  // by hand; everything left is ask-me-at-send.
  for (const f of scalarFields) {
    if (f.key in resolved) continue;
    if (isSection(f)) continue;
    if (takePerDeal(f)) continue;
    const missing = evaluated.unresolved[f.key];
    unresolved.push({
      key: f.key,
      label: f.label,
      required: f.required,
      reason: missing
        ? `waiting on: ${missing.join(", ")}`
        : f.source !== "conditional" && f.expression && evaluated.errors[f.key]
          ? evaluated.errors[f.key]!
          : "enter this value",
    });
  }

  // Emit values in TEMPLATE field order, not the order the passes happened to
  // fill them. Otherwise editing a field moves it to the front of the panel
  // mid-keystroke, and resolved_data for the same template varies by which
  // pass won — order should reflect the document, not the resolution path.
  const ordered: Record<string, ResolvedField> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v) ordered[f.key] = v;
  }

  return {
    sentDate: inputs.sentDate,
    values: ordered,
    groups,
    unresolved,
    payloadMisses,
    structured,
    conditions,
  };
}
