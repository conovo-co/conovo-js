import { describe, expect, it } from "vitest";
import { claimedSpans, fieldOwningBlank, fieldsForUnmappedBlanks } from "./blanks.js";

const paras = [
  { index: 0, text: "Fee: [AMOUNT], payable within [THIRTY (30)] days." },
  { index: 1, text: "Freight includes [delivery to the receiving warehouse]." },
  { index: 2, text: "Rooms in scope: [List each room / area]" },
];

const item = (over: Partial<Parameters<typeof claimedSpans>[1][0][0]> = {}) => ({
  accepted: true,
  key: "k",
  occurrences: [],
  ...over,
});

describe("fieldsForUnmappedBlanks", () => {
  it("makes a field for every marker nothing covers, named from context where it exists", () => {
    const made = fieldsForUnmappedBlanks(paras, [], []);
    // "Fee: [AMOUNT]" and "Rooms in scope: [...]" have colon lead-ins — the
    // author's own label beats the marker's text. Mid-sentence markers keep
    // the marker's words: a wrong-but-plausible name is worse than an ugly one.
    expect(made.map((f) => f.label)).toEqual([
      "Fee",
      "THIRTY (30)",
      "delivery to the receiving warehouse",
      "Rooms in scope",
    ]);
    // Accepted, so the user's job is switching OFF the ones that are wording.
    expect(made.every((f) => f.accepted)).toBe(true);
    // per_deal: being asked each time beats something filling in silently.
    expect(made.every((f) => f.source === "per_deal")).toBe(true);
  });

  it("anchors each field to the marker itself, so the fill step can replace it", () => {
    const made = fieldsForUnmappedBlanks(paras, [], []);
    expect(made[0]!.occurrences).toEqual([{ paragraphIndex: 0, snippet: "[AMOUNT]" }]);
  });

  it("types them from the marker's own words", () => {
    const made = fieldsForUnmappedBlanks(paras, [], []);
    // A short phrase stays a one-line text; only a list or a long instruction
    // ("[List each room / area]") is prose the user has to write out.
    // "[THIRTY (30)]" is text, not duration: the word "days" sits OUTSIDE the
    // marker, so the marker alone doesn't name a unit. Guessing from
    // surrounding prose would be reaching — the user picks the type on the
    // card, and a duration typed as text still fills correctly.
    expect(made.map((f) => f.type)).toEqual(["money", "text", "text", "long_text"]);
  });

  it("skips a marker an UNACCEPTED proposal already owns, to avoid duplicates", () => {
    // The extraction proposed something here but wasn't confident; the field
    // exists and is switched off. A second field beside it helps nobody.
    const existing = [
      item({ key: "freight", occurrences: [{ paragraphIndex: 1, snippet: "Freight includes [delivery to the receiving warehouse]." }], accepted: false }),
    ];
    const made = fieldsForUnmappedBlanks(paras, existing, []);
    expect(made.map((f) => f.label)).not.toContain("delivery to the receiving warehouse");
  });

  it("counts parties, groups and sections as covering too", () => {
    const others = [[item({ key: "p", occurrences: [{ paragraphIndex: 0, snippet: "[AMOUNT]" }] })]];
    const made = fieldsForUnmappedBlanks(paras, [], others);
    expect(made.map((f) => f.label)).not.toContain("AMOUNT");
  });

  it("never collides with an existing field key", () => {
    const existing = [item({ key: "fee", occurrences: [] })];
    const made = fieldsForUnmappedBlanks(paras, existing, []);
    expect(made.find((f) => f.label === "Fee")!.key).toBe("fee_2");
  });

  it("keys follow the context label, so standing values key on the meaningful name", () => {
    const made = fieldsForUnmappedBlanks(paras, [], []);
    expect(made.find((f) => f.label === "Fee")!.key).toBe("fee");
    expect(made.find((f) => f.label === "Rooms in scope")!.key).toBe("rooms_in_scope");
  });

  it("names a marker after its table row", () => {
    const tableParas = [
      { index: 0, text: "Design fee" },
      { index: 1, text: "$[AMOUNT]" },
    ];
    const tables = [{ startIndex: 0, bordered: true, rows: [[{ paragraphs: [0] }, { paragraphs: [1] }]] }];
    const made = fieldsForUnmappedBlanks(tableParas, [], [], tables);
    expect(made.map((f) => f.label)).toEqual(["Design fee amount"]);
    expect(made[0]!.key).toBe("design_fee_amount");
  });

  it("returns nothing when the document hasn't loaded", () => {
    expect(fieldsForUnmappedBlanks([], [], [])).toEqual([]);
  });
});

describe("claimedSpans", () => {
  it("ignores unaccepted items when asked for what will actually fill", () => {
    const items = [item({ occurrences: [{ paragraphIndex: 0, snippet: "[AMOUNT]" }], accepted: false })];
    expect(claimedSpans(paras, [items], true)).toEqual([]);
    expect(claimedSpans(paras, [items], false)).toEqual([
      { paragraphIndex: 0, start: 5, end: 13 },
    ]);
  });

  it("skips a snippet that no longer appears in its paragraph", () => {
    const items = [item({ occurrences: [{ paragraphIndex: 0, snippet: "text since edited away" }] })];
    expect(claimedSpans(paras, [items], false)).toEqual([]);
  });
});

describe("fieldOwningBlank", () => {
  it("matches on overlap, since a snippet is usually the surrounding phrase", () => {
    const fields = [
      item({
        key: "freight",
        accepted: false,
        occurrences: [
          { paragraphIndex: 1, snippet: "Freight includes [delivery to the receiving warehouse]." },
        ],
      }),
    ];
    const blank = { paragraphIndex: 1, start: 17, end: 54 };
    expect(fieldOwningBlank(paras, fields, blank)?.key).toBe("freight");
  });

  it("won't match a field in a different paragraph", () => {
    const fields = [item({ key: "x", occurrences: [{ paragraphIndex: 0, snippet: "[AMOUNT]" }] })];
    expect(fieldOwningBlank(paras, fields, { paragraphIndex: 1, start: 17, end: 54 })).toBeUndefined();
  });
});
