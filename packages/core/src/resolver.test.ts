import { describe, expect, it } from "vitest";
import { resolveFields, type ResolverField, type ResolveInputs } from "./resolver.js";
import { validateResolved, validationBlocksSend } from "./validator.js";
import { serializeValue } from "./values.js";
import { money, num, text, date } from "./expressions/value.js";

const SENT = "2026-08-01";

const f = (over: Partial<ResolverField> & Pick<ResolverField, "key" | "type">): ResolverField => ({
  label: over.key,
  source: "per_deal",
  required: true,
  ...over,
});

const resolve = (fields: ResolverField[], inputs: Partial<ResolveInputs> = {}) =>
  resolveFields(fields, { sentDate: SENT, ...inputs });

const sMoney = (n: string) => serializeValue(money(n));
const sText = (v: string) => serializeValue(text(v));

describe("resolution priority (SPEC §3.3)", () => {
  const field = f({
    key: "fee",
    type: "money",
    source: "platform_bound",
    bindingPath: "project.fee",
    defaultValue: sMoney("100"),
  });

  it("platform payload wins over everything", () => {
    const r = resolve([field], {
      payload: { project: { fee: 4500 } },
      workspaceDefaults: { fee: sMoney("200") },
      presetValues: { fee: sMoney("300") },
      perDeal: { fee: sMoney("400") },
    });
    expect(r.values["fee"]).toEqual({ value: sMoney("4500"), provenance: "platform" });
  });

  it("falls through to live workspace default on payload miss, recording the miss", () => {
    const r = resolve([field], {
      payload: { project: {} },
      workspaceDefaults: { fee: sMoney("200") },
      perDeal: { fee: sMoney("400") },
    });
    expect(r.values["fee"]).toEqual({ value: sMoney("200"), provenance: "workspace_default" });
    expect(r.payloadMisses).toEqual([{ key: "fee", bindingPath: "project.fee", reason: "absent" }]);
  });

  it("uses the version-pinned default when the live workspace default is gone", () => {
    const r = resolve([field], { payload: {} });
    expect(r.values["fee"]).toEqual({ value: sMoney("100"), provenance: "workspace_default" });
  });

  it("records a mismatch miss when the payload value can't become the type", () => {
    const r = resolve([f({ key: "fee", type: "money", bindingPath: "project.fee" })], {
      payload: { project: { fee: "call for pricing" } },
      presetValues: { fee: sMoney("300") },
    });
    expect(r.payloadMisses[0]?.reason).toBe("mismatch");
    expect(r.values["fee"]).toEqual({ value: sMoney("300"), provenance: "preset" });
  });

  it("preset beats per-deal; per-deal is the last resort", () => {
    const bare = f({ key: "terms", type: "text" });
    const withPreset = resolve([bare], {
      presetValues: { terms: sText("Net 15") },
      perDeal: { terms: sText("Net 60") },
    });
    expect(withPreset.values["terms"]?.provenance).toBe("preset");
    const withPerDeal = resolve([bare], { perDeal: { terms: sText("Net 60") } });
    expect(withPerDeal.values["terms"]).toEqual({ value: sText("Net 60"), provenance: "per_deal" });
  });

  it("rejects stored values whose kind doesn't match the field type", () => {
    const r = resolve([f({ key: "fee", type: "money" })], {
      perDeal: { fee: sText("four thousand") },
    });
    expect(r.values["fee"]).toBeUndefined();
    expect(r.unresolved[0]?.key).toBe("fee");
  });
});

/**
 * An override is a human correcting an answer the chain produced. Unlike
 * per-deal (the last resort), it outranks every automatic source — otherwise
 * the send panel could show an editable value that silently reverts on send.
 */
describe("send-time overrides (SPEC §3.3)", () => {
  const field = f({
    key: "fee",
    type: "money",
    source: "platform_bound",
    bindingPath: "project.fee",
    defaultValue: sMoney("100"),
  });

  it("beats the platform payload, the strongest automatic source", () => {
    const r = resolve([field], {
      payload: { project: { fee: 4500 } },
      overrides: { fee: sMoney("5200") },
    });
    expect(r.values["fee"]).toEqual({ value: sMoney("5200"), provenance: "edited" });
  });

  it("beats workspace default, preset, and per-deal together", () => {
    const r = resolve([field], {
      payload: {},
      workspaceDefaults: { fee: sMoney("200") },
      presetValues: { fee: sMoney("300") },
      perDeal: { fee: sMoney("400") },
      overrides: { fee: sMoney("900") },
    });
    expect(r.values["fee"]).toEqual({ value: sMoney("900"), provenance: "edited" });
  });

  it("does not record a payload miss for a field the user edited", () => {
    const r = resolve([field], {
      payload: { project: {} },
      overrides: { fee: sMoney("900") },
    });
    expect(r.payloadMisses).toEqual([]);
  });

  it("beats a field's own formula", () => {
    const computed = f({
      key: "deposit",
      type: "money",
      source: "computed",
      expression: "total * 0.5",
    });
    const total = f({ key: "total", type: "money" });
    const r = resolve([total, computed], {
      perDeal: { total: sMoney("1000") },
      overrides: { deposit: sMoney("250") },
    });
    expect(r.values["deposit"]).toEqual({ value: sMoney("250"), provenance: "edited" });
  });

  it("recomputes DEPENDENT formulas from the edited value", () => {
    const total = f({ key: "total", type: "money", bindingPath: "project.fee" });
    const half = f({
      key: "initial",
      type: "money",
      source: "computed",
      expression: "total * 0.5",
    });
    const r = resolve([total, half], {
      payload: { project: { fee: 0 } },
      overrides: { total: sMoney("4000") },
    });
    expect(r.values["total"]?.provenance).toBe("edited");
    // The whole point of editing a total: the split follows it.
    expect(r.values["initial"]).toEqual({ value: sMoney("2000"), provenance: "computed" });
  });

  it("ignores an override whose kind doesn't match the field type", () => {
    const r = resolve([field], {
      payload: { project: { fee: 4500 } },
      overrides: { fee: sText("five thousand") },
    });
    expect(r.values["fee"]).toEqual({ value: sMoney("4500"), provenance: "platform" });
  });

  it("keeps values in template field order so an edited field doesn't jump", () => {
    const a = f({ key: "a", type: "text" });
    const b = f({ key: "b", type: "text", bindingPath: "x" });
    const c = f({ key: "c", type: "text" });
    const r = resolve([a, b, c], {
      payload: { x: "from payload" },
      perDeal: { a: sText("typed"), c: sText("typed too") },
      overrides: { c: sText("edited last, listed last") },
    });
    expect(Object.keys(r.values)).toEqual(["a", "b", "c"]);
  });

  it("leaves unrelated fields on their normal provenance", () => {
    const other = f({ key: "terms", type: "text" });
    const r = resolve([field, other], {
      payload: { project: { fee: 4500 } },
      presetValues: { terms: sText("Net 15") },
      overrides: { fee: sMoney("5200") },
    });
    expect(r.values["terms"]?.provenance).toBe("preset");
  });
});

describe("computed fields", () => {
  const total = f({ key: "total_fee", type: "money" });
  const deposit = f({
    key: "deposit",
    type: "money",
    source: "computed",
    expression: "50% * total_fee",
  });
  const balance = f({
    key: "balance",
    type: "money",
    source: "computed",
    expression: "total_fee - deposit",
  });

  it("computes from per-deal inputs, chained in dependency order", () => {
    const r = resolve([total, deposit, balance], {
      perDeal: { total_fee: sMoney("4500") },
    });
    expect(r.values["deposit"]).toEqual({ value: sMoney("2250"), provenance: "computed" });
    expect(r.values["balance"]).toEqual({ value: sMoney("2250"), provenance: "computed" });
    expect(r.unresolved).toEqual([]);
  });

  it("a field's own formula outranks a per-deal override of itself", () => {
    const r = resolve([total, deposit], {
      perDeal: { total_fee: sMoney("4500"), deposit: sMoney("999") },
    });
    expect(r.values["deposit"]).toEqual({ value: sMoney("2250"), provenance: "computed" });
  });

  it("computed with missing inputs falls back to a hand-entered value", () => {
    const r = resolve([total, deposit], { perDeal: { deposit: sMoney("999") } });
    expect(r.values["deposit"]).toEqual({ value: sMoney("999"), provenance: "per_deal" });
    expect(r.unresolved.map((u) => u.key)).toEqual(["total_fee"]);
  });

  it("reports what a stuck formula is waiting on", () => {
    const r = resolve([total, deposit]);
    const dep = r.unresolved.find((u) => u.key === "deposit");
    expect(dep?.reason).toBe("waiting on: total_fee");
  });

  it("date formulas use the caller's sentDate", () => {
    const end = f({
      key: "end_date",
      type: "date",
      source: "computed",
      expression: "addDays(sentDate(), 30)",
    });
    const r = resolve([end]);
    expect(r.values["end_date"]?.value).toEqual(serializeValue(date("2026-08-31")));
  });
});

describe("repeating groups and structured fields", () => {
  const sched = f({
    key: "schedule",
    type: "repeating_group",
    config: {
      columns: [
        { key: "milestone", label: "Milestone", type: "text" },
        { key: "amount", label: "Amount", type: "money" },
      ],
    },
  });

  it("coerces rows by column type and exposes them to formulas", () => {
    const totalOfRows = f({
      key: "total",
      type: "money",
      source: "computed",
      expression: "sum(schedule.amount)",
    });
    const r = resolve([sched, totalOfRows], {
      groupRows: {
        schedule: [
          { milestone: sText("Design"), amount: sMoney("1000") },
          { milestone: sText("Install"), amount: sMoney("2500") },
        ],
      },
    });
    expect(r.groups["schedule"]).toHaveLength(2);
    expect(r.values["total"]).toEqual({ value: sMoney("3500"), provenance: "computed" });
  });

  it("group without rows is unresolved; parties are surfaced as structured", () => {
    const party = f({ key: "client", type: "party", config: { isSender: false } });
    const r = resolve([sched, party]);
    expect(r.unresolved[0]?.key).toBe("schedule");
    expect(r.structured).toEqual(["client"]);
  });
});

describe("validateResolved (SPEC §3.4.4)", () => {
  const total = f({ key: "total_fee", type: "money", label: "Total fee" });
  const deposit = f({
    key: "deposit",
    type: "money",
    label: "Deposit",
    source: "computed",
    expression: "50% * total_fee",
  });

  it("passes a clean resolution", () => {
    const r = resolve([total, deposit], { perDeal: { total_fee: sMoney("4500") } });
    const issues = validateResolved([total, deposit], r);
    expect(issues).toEqual([]);
    expect(validationBlocksSend(issues)).toBe(false);
  });

  it("missing required field blocks the send", () => {
    const r = resolve([total]);
    const issues = validateResolved([total], r);
    expect(issues[0]).toMatchObject({ severity: "error", code: "required_missing", fieldKey: "total_fee" });
    expect(validationBlocksSend(issues)).toBe(true);
  });

  it("optional missing field does not block", () => {
    const opt = f({ key: "notes", type: "text", required: false });
    const issues = validateResolved([opt], resolve([opt]));
    expect(issues).toEqual([]);
  });

  it("unfilled conditional field warns but never blocks (SPEC §3.2 exempt)", () => {
    const cond = f({
      key: "military_id",
      type: "text",
      label: "Military ID",
      source: "conditional",
      required: true,
    });
    const issues = validateResolved([cond], resolve([cond]));
    expect(issues[0]).toMatchObject({
      severity: "warning",
      code: "conditional_unfilled",
      fieldKey: "military_id",
    });
    expect(validationBlocksSend(issues)).toBe(false);
  });
});

describe("conditional sections (SPEC §3.1/§3.2 — required when applicable)", () => {
  const deposit = f({ key: "deposit", type: "money" });
  const blank = f({
    key: "deposit_due_date",
    type: "date",
    label: "Deposit due date",
    source: "conditional",
    expression: "deposit > $0",
    required: true,
  });
  const section = f({
    key: "deposit_clause",
    type: "text",
    label: "Deposit clause",
    source: "conditional",
    expression: "deposit > $0",
    config: { paragraphIndexes: [4, 5] },
  });

  it("evaluates conditions over resolved values into their own map", () => {
    const r = resolve([deposit, blank, section], {
      perDeal: { deposit: sMoney("500") },
    });
    expect(r.conditions).toEqual({ deposit_due_date: true, deposit_clause: true });
    // A condition is never a document value.
    expect(r.values["deposit_clause"]).toBeUndefined();
    expect(r.values["deposit_due_date"]).toBeUndefined();
  });

  it("condition true + blank unfilled → blocking error", () => {
    const r = resolve([deposit, blank], { perDeal: { deposit: sMoney("500") } });
    const issues = validateResolved([deposit, blank], r);
    expect(issues[0]).toMatchObject({
      severity: "error",
      code: "required_missing",
      fieldKey: "deposit_due_date",
    });
    expect(validationBlocksSend(issues)).toBe(true);
  });

  it("condition false → no issue at all, and the blank stays out", () => {
    const r = resolve([deposit, blank, section], {
      perDeal: { deposit: sMoney("0") },
    });
    expect(r.conditions).toEqual({ deposit_due_date: false, deposit_clause: false });
    expect(validateResolved([deposit, blank, section], r)).toEqual([]);
  });

  it("condition true + blank filled per-deal → clean", () => {
    const r = resolve([deposit, blank], {
      perDeal: { deposit: sMoney("500"), deposit_due_date: serializeValue(date("2026-09-01")) },
    });
    expect(r.values["deposit_due_date"]).toMatchObject({ provenance: "per_deal" });
    expect(validateResolved([deposit, blank], r)).toEqual([]);
  });

  it("section-only fields never appear in unresolved", () => {
    const r = resolve([deposit, section], { perDeal: { deposit: sMoney("0") } });
    expect(r.unresolved.map((u) => u.key)).not.toContain("deposit_clause");
  });

  it("a condition that can't produce yes/no → null → warning, never block", () => {
    const weird = f({
      key: "odd",
      type: "text",
      source: "conditional",
      expression: "deposit + $1", // money, not boolean
      required: true,
    });
    const missingInput = f({
      key: "dangling",
      type: "text",
      source: "conditional",
      expression: "nonexistent > 0",
      required: true,
    });
    const r = resolve([deposit, weird, missingInput], {
      perDeal: { deposit: sMoney("10") },
    });
    expect(r.conditions).toEqual({ odd: null, dangling: null });
    const issues = validateResolved([deposit, weird, missingInput], r);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(validationBlocksSend(issues)).toBe(false);
  });
});

describe("validateResolved — math and structure", () => {
  const total = f({ key: "total_fee", type: "money", label: "Total fee" });
  const deposit = f({
    key: "deposit",
    type: "money",
    label: "Deposit",
    source: "computed",
    expression: "50% * total_fee",
  });

  it("empty required text blocks", () => {
    const notes = f({ key: "notes", type: "text", label: "Notes" });
    const r = resolve([notes], { perDeal: { notes: sText("   ") } });
    // parseValueInput would refuse this, but a stored preset/default could carry it.
    r.values["notes"] = { value: sText("  "), provenance: "per_deal" };
    const issues = validateResolved([notes], r);
    expect(issues[0]?.code).toBe("required_empty");
  });

  it("inconsistent math blocks: hand-tampered computed value", () => {
    const r = resolve([total, deposit], { perDeal: { total_fee: sMoney("4500") } });
    r.values["deposit"] = { value: sMoney("999"), provenance: "per_deal" };
    const issues = validateResolved([total, deposit], r);
    const math = issues.find((i) => i.code === "inconsistent_math");
    expect(math?.message).toContain("$999.00");
    expect(math?.message).toContain("$2,250.00");
    expect(validationBlocksSend(issues)).toBe(true);
  });

  it("incomplete group rows block", () => {
    const sched = f({
      key: "schedule",
      type: "repeating_group",
      label: "Payment schedule",
      config: {
        columns: [
          { key: "milestone", label: "Milestone", type: "text" },
          { key: "amount", label: "Amount", type: "money" },
        ],
      },
    });
    const r = resolve([sched], {
      groupRows: { schedule: [{ milestone: sText("Design") }] },
    });
    const issues = validateResolved([sched], r);
    expect(issues[0]).toMatchObject({ severity: "error", code: "group_row_incomplete" });
    expect(issues[0]?.message).toContain('missing "Amount"');
  });

  it("warnings flag negative money but do not block alone", () => {
    const r = resolve([total], { perDeal: { total_fee: sMoney("-100") } });
    const issues = validateResolved([total], r);
    expect(issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "negative_money" }),
    ]);
    expect(validationBlocksSend(issues)).toBe(false);
  });

  it("division by zero surfaces as a formula error", () => {
    const rate = f({ key: "rate", type: "number" });
    const per = f({
      key: "per_unit",
      type: "number",
      label: "Per unit",
      source: "computed",
      expression: "total_fee / rate",
    });
    const r = resolve([total, rate, per], {
      perDeal: { total_fee: sMoney("100"), rate: serializeValue(num("0")) },
    });
    // The resolver leaves per_unit unresolved (evaluation error) — required ⇒ blocks.
    const issues = validateResolved([total, rate, per], r);
    expect(issues[0]).toMatchObject({ code: "required_missing", fieldKey: "per_unit" });
    expect(issues[0]?.message).toContain("division by zero");
  });

  it("reproducibility: same fields + same inputs ⇒ identical resolved_data", () => {
    const inputs = { perDeal: { total_fee: sMoney("4500") } };
    const a = resolve([total, deposit], inputs);
    const b = resolve([total, deposit], inputs);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
