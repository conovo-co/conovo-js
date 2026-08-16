import type { FieldType } from "./fields.js";
import { repeatingGroupFieldConfigSchema } from "./fields.js";
import { deserializeValue, valueKindForType } from "./values.js";
import {
  evaluateFormulas,
  toDisplayString,
  type Value,
} from "./expressions/index.js";
import type { ResolverField, ResolutionResult } from "./resolver.js";

/**
 * Deterministic validation gate (docs/SPEC.md §3.4.4, CLAUDE.md invariant 6).
 * Any `error` issue demotes the send to draft-for-review — silent failure
 * becomes a draft, never a sent contract. Pure code; the optional AI anomaly
 * check is elsewhere and can only ever add flags, not values.
 */

export interface ValidationIssue {
  severity: "error" | "warning";
  /** Machine-readable: required_missing | type_mismatch | inconsistent_math | … */
  code: string;
  fieldKey?: string;
  /** Plain English, shown to the business user. */
  message: string;
}

function isEmpty(v: Value): boolean {
  return (
    (v.kind === "text" && v.value.trim() === "") ||
    (v.kind === "list" && v.items.length === 0)
  );
}

export function validateResolved(
  fields: ResolverField[],
  resolution: ResolutionResult,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));

  // 1. Required fields must have resolved, non-empty values. Conditional
  // fields are "required when applicable" (SPEC §3.2): their evaluated
  // condition decides. False → the section is out of the document, nothing
  // to require. True → the blank is genuinely required. No condition (or one
  // that couldn't produce yes/no) → warn, never block — the document keeps
  // its own text at the anchor.
  for (const u of resolution.unresolved) {
    if (!u.required) continue;
    if (byKey.get(u.key)?.source === "conditional") {
      const condition = resolution.conditions[u.key];
      if (condition === false) continue;
      if (condition === true) {
        issues.push({
          severity: "error",
          code: "required_missing",
          fieldKey: u.key,
          message: `"${u.label}" is required — its section applies to this contract.`,
        });
        continue;
      }
      issues.push({
        severity: "warning",
        code: "conditional_unfilled",
        fieldKey: u.key,
        message: `"${u.label}" is blank — fine if that section doesn't apply to this contract.`,
      });
      continue;
    }
    issues.push({
      severity: "error",
      code: "required_missing",
      fieldKey: u.key,
      message: `"${u.label}" has no value — ${u.reason}`,
    });
  }
  for (const [key, rf] of Object.entries(resolution.values)) {
    const field = byKey.get(key);
    if (field?.required && isEmpty(deserializeValue(rf.value)))
      issues.push({
        severity: "error",
        code: "required_empty",
        fieldKey: key,
        message: `"${field.label}" is empty`,
      });
  }

  // 2. Type sanity: every resolved value's kind matches its field type.
  for (const [key, rf] of Object.entries(resolution.values)) {
    const field = byKey.get(key);
    if (!field) continue;
    const kind = valueKindForType(field.type);
    if (kind !== null && rf.value.kind !== kind)
      issues.push({
        severity: "error",
        code: "type_mismatch",
        fieldKey: key,
        message: `"${field.label}" resolved to a ${rf.value.kind}, expected ${kind}`,
      });
  }

  // 3. Computed consistency: recompute every formula from the resolved inputs
  //    and require the stored value to match — catches hand-edited overrides
  //    and any drift ("deposit + balance must equal total" falls out of this).
  const ctxFields: Record<string, Value> = {};
  for (const [key, rf] of Object.entries(resolution.values))
    ctxFields[key] = deserializeValue(rf.value);
  const ctxGroups: Record<string, Array<Record<string, Value>>> = {};
  for (const [key, rows] of Object.entries(resolution.groups))
    ctxGroups[key] = rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, sv]) => [k, deserializeValue(sv)])),
    );

  const formulas: Record<string, string> = {};
  for (const f of fields) {
    // A conditional field's expression is its CONDITION, not a value formula —
    // comparing the blank's value against a boolean would be nonsense.
    if (f.source === "conditional") continue;
    if (f.expression && f.key in resolution.values) formulas[f.key] = f.expression;
  }
  const recomputed = evaluateFormulas(formulas, {
    fields: ctxFields,
    groups: ctxGroups,
    sentDate: resolution.sentDate,
    today: resolution.sentDate,
  });
  for (const [key, expected] of Object.entries(recomputed.values)) {
    const actual = ctxFields[key];
    if (!actual) continue;
    if (toDisplayString(actual) !== toDisplayString(expected)) {
      const field = byKey.get(key);
      issues.push({
        severity: "error",
        code: "inconsistent_math",
        fieldKey: key,
        message: `"${field?.label ?? key}" is ${toDisplayString(actual)} but its formula computes ${toDisplayString(expected)}`,
      });
    }
  }
  for (const [key, msg] of Object.entries(recomputed.errors)) {
    const field = byKey.get(key);
    issues.push({
      severity: "error",
      code: "formula_error",
      fieldKey: key,
      message: `"${field?.label ?? key}" formula failed: ${msg}`,
    });
  }

  // 4. Repeating groups: every row must fill every column (a half-empty row
  //    in a payment schedule is a real-world contract bug).
  for (const f of fields) {
    if (f.type !== "repeating_group") continue;
    const rows = resolution.groups[f.key];
    if (!rows) continue;
    const cfg = repeatingGroupFieldConfigSchema.safeParse(f.config ?? {});
    if (!cfg.success) continue;
    rows.forEach((row, i) => {
      for (const col of cfg.data.columns) {
        if (!(col.key in row))
          issues.push({
            severity: "error",
            code: "group_row_incomplete",
            fieldKey: f.key,
            message: `"${f.label}" row ${i + 1} is missing "${col.label}"`,
          });
      }
    });
  }

  // 5. Plausibility warnings — never block on their own, but demand a look.
  for (const [key, rf] of Object.entries(resolution.values)) {
    const v = deserializeValue(rf.value);
    const field = byKey.get(key);
    if (v.kind === "money" && v.amount.isNegative())
      issues.push({
        severity: "warning",
        code: "negative_money",
        fieldKey: key,
        message: `"${field?.label ?? key}" is negative (${toDisplayString(v)})`,
      });
    if (v.kind === "duration" && v.n === 0)
      issues.push({
        severity: "warning",
        code: "zero_duration",
        fieldKey: key,
        message: `"${field?.label ?? key}" is zero ${v.unit}`,
      });
  }

  return issues;
}

/** Convenience for the send path: any error ⇒ draft-for-review. */
export function validationBlocksSend(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
