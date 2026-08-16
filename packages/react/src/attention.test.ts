import { describe, expect, it } from "vitest";
import {
  BLANKS_CARD,
  collectAttention,
  nextAttentionCard,
  type AttentionItem,
} from "./attention.js";

const THRESHOLD = 0.7;

type Field = Parameters<typeof collectAttention>[0]["fields"][number];

function field(over: Partial<Field> = {}): Field {
  return {
    accepted: true,
    key: "total_fee",
    label: "Total fee",
    type: "money",
    source: "per_deal",
    confidence: 0.95,
    ...over,
  };
}

function collect(over: Partial<Parameters<typeof collectAttention>[0]> = {}) {
  return collectAttention({
    fields: [],
    sections: [],
    blankCount: 0,
    ...over,
  });
}

const reasons = (items: AttentionItem[]) => items.map((i) => i.reason);

describe("collectAttention", () => {
  it("says nothing when every proposal is confident and complete", () => {
    expect(collect({ fields: [field()] })).toEqual([]);
  });

  it("flags a standing term with no value — it silently asks every send", () => {
    const items = collect({
      fields: [field({ source: "workspace_default" })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ cardKey: "total_fee", tone: "fix" });
  });

  it("stays quiet once the standing term has a value, or one is already saved", () => {
    expect(
      collect({ fields: [field({ source: "workspace_default", defaultRaw: "$4,500" })] }),
    ).toEqual([]);
    expect(
      collect({ fields: [field({ source: "workspace_default", hasSavedDefault: true })] }),
    ).toEqual([]);
  });

  it("surfaces an unparseable standing value with the parser's own message", () => {
    const items = collect({
      fields: [field({ source: "workspace_default", defaultRaw: "not money" })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.tone).toBe("fix");
    expect(items[0]!.reason).not.toBe("");
  });

  it("flags a calculated field with no formula", () => {
    expect(reasons(collect({ fields: [field({ source: "computed" })] }))).toEqual([
      "set to calculate but has no formula — it won't fill",
    ]);
    expect(
      collect({ fields: [field({ source: "computed", expression: "0.5 * total" })] }),
    ).toEqual([]);
  });

  it("offers an unaccepted binding as free auto-fill", () => {
    const items = collect({
      fields: [field({ binding: { path: "customer.name", accepted: false } })],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.tone).toBe("check");
    expect(items[0]!.reason).toContain("customer.name");
  });

  it("ignores unchecked fields entirely, however unsure we were", () => {
    // An unchecked field isn't in the template, so nothing about it can be
    // wrong — flagging one reads as an error you can't clear.
    expect(collect({ fields: [field({ accepted: false, confidence: 0.4 })] })).toEqual([]);
    expect(collect({ fields: [field({ accepted: false, confidence: 0.95 })] })).toEqual([]);
    // Even a genuinely broken standing value stays silent while unchecked.
    expect(
      collect({
        fields: [
          field({ accepted: false, source: "workspace_default", defaultRaw: "not a date", type: "date" }),
        ],
      }),
    ).toEqual([]);
    // Checking that same field back on surfaces it again.
    expect(
      collect({
        fields: [
          field({ accepted: true, source: "workspace_default", defaultRaw: "not a date", type: "date" }),
        ],
      }),
    ).toHaveLength(1);
  });

  it("treats every unaccepted section as an open decision, then wants its condition", () => {
    const section = {
      accepted: false,
      key: "deposit_clause",
      label: "Deposit clause",
      expression: "",
      confidence: 0.8,
    };
    expect(collect({ sections: [section] })).toHaveLength(1);
    const accepted = collect({ sections: [{ ...section, accepted: true }] });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.tone).toBe("fix");
    expect(
      collect({ sections: [{ ...section, accepted: true, expression: "deposit > 0" }] }),
    ).toEqual([]);
  });

  it("rolls unmapped blanks into one entry pointing at their block", () => {
    const items = collect({ blankCount: 3 });
    expect(items).toEqual([
      expect.objectContaining({ cardKey: BLANKS_CARD, label: "3 unmapped blanks", tone: "fix" }),
    ]);
    expect(collect({ blankCount: 1 })[0]!.label).toBe("1 unmapped blank");
  });

  it("puts what will be wrong ahead of what is merely undecided", () => {
    const items = collect({
      fields: [
        // Distinct labels on purpose — same-named fields are their own finding,
        // and this test is about ordering.
        field({ key: "a", label: "Client name", binding: { path: "customer.name", accepted: false } }),
        field({ key: "b", label: "Balance due", source: "computed" }),
      ],
    });
    expect(items.map((i) => i.cardKey)).toEqual(["b", "a"]);
  });

  it("flags fields that share a name — one entry, pointing at the first", () => {
    // The blank-derived case: a document repeating one fill-in marker yields
    // several fields all named after it, and the name distinguishes nothing.
    const items = collect({
      fields: [
        field({ key: "d1", label: "DATES / weeks" }),
        field({ key: "d2", label: "DATES / weeks" }),
        field({ key: "d3", label: "DATES / weeks" }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.cardKey).toBe("d1");
    expect(items[0]!.tone).toBe("fix");
    expect(items[0]!.reason).toContain("3 fields share this name");
  });

  it("compares names ignoring case and surrounding space", () => {
    const items = collect({
      fields: [
        field({ key: "a", label: "Start date" }),
        field({ key: "b", label: "  start DATE " }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toContain("2 fields share this name");
  });

  it("counts only checked fields, so unchecking one can resolve the clash", () => {
    const both = collect({
      fields: [
        field({ key: "a", label: "DATES / weeks" }),
        field({ key: "b", label: "DATES / weeks" }),
      ],
    });
    expect(both).toHaveLength(1);
    const oneOff = collect({
      fields: [
        field({ key: "a", label: "DATES / weeks" }),
        field({ key: "b", label: "DATES / weeks", accepted: false }),
      ],
    });
    expect(oneOff).toEqual([]);
  });

  it("shrinks the group as they get renamed, and goes quiet at the end", () => {
    const renamedOne = collect({
      fields: [
        field({ key: "d1", label: "Install date" }),
        field({ key: "d2", label: "DATES / weeks" }),
        field({ key: "d3", label: "DATES / weeks" }),
      ],
    });
    expect(renamedOne).toHaveLength(1);
    expect(renamedOne[0]!.cardKey).toBe("d2");
    expect(renamedOne[0]!.reason).toContain("2 fields share this name");
    expect(
      collect({
        fields: [
          field({ key: "d1", label: "Install date" }),
          field({ key: "d2", label: "Delivery date" }),
          field({ key: "d3", label: "Punch list date" }),
        ],
      }),
    ).toEqual([]);
  });

  it("still walks the user through conditional sections, which never auto-accept", () => {
    // Sections are the one thing that starts unaccepted BY DESIGN (invariant
    // 1), so an unaccepted one is an open question rather than a decision.
    const section = { accepted: false, key: "s1", label: "Deposit clause", expression: "" };
    expect(collect({ sections: [section] })).toHaveLength(1);
  });
});

describe("nextAttentionCard", () => {
  const item = (cardKey: string, tone: AttentionItem["tone"] = "fix"): AttentionItem => ({
    cardKey,
    label: cardKey,
    reason: "because",
    tone,
  });

  it("starts at the top when nothing has been visited", () => {
    expect(nextAttentionCard([item("a"), item("b")], null)).toBe("a");
  });

  it("advances past the card it last sent you to", () => {
    expect(nextAttentionCard([item("a"), item("b"), item("c")], "a")).toBe("b");
    expect(nextAttentionCard([item("a"), item("b"), item("c")], "b")).toBe("c");
  });

  it("wraps rather than dead-ending on the last one", () => {
    expect(nextAttentionCard([item("a"), item("b")], "b")).toBe("a");
  });

  it("restarts from the top when the current card has been fixed away", () => {
    // "a" was resolved, so collectAttention no longer returns it. Resuming by
    // index would land somewhere arbitrary; by value we just start over.
    expect(nextAttentionCard([item("b"), item("c")], "a")).toBe("b");
  });

  it("skips a second reason naming the same card", () => {
    // One field can be both unbound and missing a standing value. Landing on
    // it twice in a row reads as the button being broken.
    expect(nextAttentionCard([item("a"), item("a"), item("b")], "a")).toBe("b");
  });

  it("stays put when the only thing left is where you already are", () => {
    expect(nextAttentionCard([item("a")], "a")).toBe("a");
  });

  it("has nowhere to go when everything is resolved", () => {
    expect(nextAttentionCard([], null)).toBeNull();
    expect(nextAttentionCard([], "a")).toBeNull();
  });

  it("follows the list's order, so fixes come before checks", () => {
    // collectAttention returns fix-then-check; the walk must not re-sort.
    const items = [item("bad", "fix"), item("unsure", "check")];
    expect(nextAttentionCard(items, null)).toBe("bad");
    expect(nextAttentionCard(items, "bad")).toBe("unsure");
  });
});
