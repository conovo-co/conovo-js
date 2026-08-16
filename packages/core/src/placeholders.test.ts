import { describe, expect, it } from "vitest";
import {
  contextLabel,
  excerptAround,
  findPlaceholders,
  isPlaceholderText,
  placeholderFieldType,
  placeholderKey,
  placeholderLabel,
  unmappedPlaceholders,
} from "./placeholders.js";

describe("isPlaceholderText", () => {
  it("catches the bracket styles templates actually use", () => {
    for (const s of [
      "[STATE]",
      "[Client Name]",
      "[entity type — e.g., limited liability company]",
      "{{client_name}}",
      "<<DATE>>",
      "{state}",
      "[ ADDRESS ]",
    ])
      expect(isPlaceholderText(s), s).toBe(true);
  });

  it("catches fill-in rules and bare markers", () => {
    for (const s of ["_____", "____________", "...", "---", "TBD", "N/A", "XXXX", "Insert"])
      expect(isPlaceholderText(s), s).toBe(true);
  });

  it("leaves real values alone — discarding one is worse than keeping a blank", () => {
    for (const s of [
      "Meadowlark Interiors",
      "Minnesota",
      "$4,500.00",
      "2245 French Lake Rd",
      "Net 30",
      "The Chen Family",
      "limited liability company",
      // Brackets INSIDE a real sentence are not a marker on their own.
      "Delaware [see Schedule A] corporation",
    ])
      expect(isPlaceholderText(s), s).toBe(false);
  });

  it("treats blank and whitespace as not-a-placeholder", () => {
    expect(isPlaceholderText("")).toBe(false);
    expect(isPlaceholderText("   ")).toBe(false);
  });

  it("catches a marker wearing formatting — '$[RATE]' is still a blank", () => {
    // Pre-filling these as standing values rendered "'$[RATE]' isn't an
    // amount" on every hourly-rate field of a real import.
    for (const s of ["$[RATE]", "([STATE])", "[X]%", "$ [AMOUNT]", "{{fee}}%"])
      expect(isPlaceholderText(s), s).toBe(true);
  });

  it("keeps words outside the brackets a value, per the conservative rule", () => {
    for (const s of ["Delaware [see Schedule A] corporation", "fee of [amount] dollars"])
      expect(isPlaceholderText(s), s).toBe(false);
  });
});

describe("findPlaceholders", () => {
  const paras = [
    { index: 0, text: "This Agreement is between [COMPANY] and [Client Name]." },
    { index: 1, text: "No markers in this paragraph at all." },
    { index: 2, text: "Governed by the laws of {{state}}." },
  ];

  it("finds every marker with its position, in reading order", () => {
    const found = findPlaceholders(paras);
    expect(found.map((f) => f.text)).toEqual([
      "[COMPANY]",
      "[Client Name]",
      "{{state}}",
    ]);
    expect(found[0]).toMatchObject({ paragraphIndex: 0, start: 26 });
  });
});

describe("unmappedPlaceholders", () => {
  const paras = [
    { index: 0, text: "Between [COMPANY] and [Client Name]." },
  ];

  it("reports only markers no field covers", () => {
    // A field claims "[COMPANY]" (chars 8-17); "[Client Name]" is unmapped.
    const left = unmappedPlaceholders(paras, [
      { paragraphIndex: 0, start: 8, end: 17 },
    ]);
    expect(left.map((f) => f.text)).toEqual(["[Client Name]"]);
  });

  it("counts partial overlap as covered — spans rarely match exactly", () => {
    const left = unmappedPlaceholders(paras, [
      { paragraphIndex: 0, start: 9, end: 12 },
      { paragraphIndex: 0, start: 22, end: 35 },
    ]);
    expect(left).toEqual([]);
  });

  it("ignores spans from a different paragraph", () => {
    const left = unmappedPlaceholders(paras, [
      { paragraphIndex: 5, start: 8, end: 17 },
    ]);
    expect(left.map((f) => f.text)).toEqual(["[COMPANY]", "[Client Name]"]);
  });
});

describe("turning a marker into a field", () => {
  it("strips brackets and trailing fill rules for the label", () => {
    expect(placeholderLabel("[AMOUNT]")).toBe("AMOUNT");
    expect(placeholderLabel("[Client opts out of publicity: ___ ]")).toBe(
      "Client opts out of publicity",
    );
    expect(placeholderLabel("{{state}}")).toBe("state");
    expect(placeholderLabel("<<DATE>>")).toBe("DATE");
  });

  it("builds a readable snake_case key, capped so it stays a key not a sentence", () => {
    expect(placeholderKey("[COUNTY, STATE]")).toBe("county_state");
    expect(placeholderKey("[ARBITRATION BODY]")).toBe("arbitration_body");
    expect(placeholderKey("[List each room / area]")).toBe("list_each_room_area");
    expect(
      placeholderKey("[concept board, preliminary space plan, budget framework]"),
    ).toBe("concept_board_preliminary_space_plan");
  });

  it("never collides with a key already in use", () => {
    expect(placeholderKey("[AMOUNT]", ["amount"])).toBe("amount_2");
    expect(placeholderKey("[AMOUNT]", ["amount", "amount_2"])).toBe("amount_3");
  });

  it("falls back to a usable key when the marker has no words", () => {
    expect(placeholderKey("[___]")).toBe("blank");
  });

  it("guesses the type from the marker's own words", () => {
    expect(placeholderFieldType("[AMOUNT]")).toBe("money");
    expect(placeholderFieldType("[Deposit]")).toBe("money");
    expect(placeholderFieldType("[SIXTY (60)] days")).toBe("duration");
    expect(placeholderFieldType("[ONE (1) year]")).toBe("duration");
    expect(placeholderFieldType("[COUNTY, STATE]")).toBe("address");
    expect(placeholderFieldType("[Effective Date]")).toBe("date");
    expect(placeholderFieldType("[ARBITRATION BODY]")).toBe("text");
  });

  it("treats a drafting instruction as prose to write, not a one-liner", () => {
    expect(placeholderFieldType("[List each room / area]")).toBe("long_text");
    expect(
      placeholderFieldType("[floor plans, elevations, finish schedule, FF&E selections]"),
    ).toBe("long_text");
  });
});

describe("excerptAround", () => {
  const paras = [
    { index: 0, text: "Short line." },
    {
      index: 1,
      text:
        "The parties agree that any dispute arising under this Agreement shall be " +
        "resolved by binding arbitration before [ARBITRATION BODY], and judgment " +
        "upon the award may be entered in any court of competent jurisdiction.",
    },
  ];

  it("returns the sentence around the field with the marker split out", () => {
    const e = excerptAround(paras, { paragraphIndex: 1, snippet: "[ARBITRATION BODY]" })!;
    expect(e.match).toBe("[ARBITRATION BODY]");
    expect(e.before).toContain("binding arbitration before");
    expect(e.after).toContain("judgment");
    expect(e.paragraphIndex).toBe(1);
  });

  it("marks elision only on the side actually trimmed", () => {
    const e = excerptAround(paras, { paragraphIndex: 1, snippet: "[ARBITRATION BODY]" })!;
    // 112 chars precede the marker, past the 90 radius — so the head is cut…
    expect(e.before.startsWith("…")).toBe(true);
    // …while the 84 chars after it fit whole, and must NOT claim otherwise.
    expect(e.after.endsWith("…")).toBe(false);
    expect(e.after).toBe(
      ", and judgment upon the award may be entered in any court of competent jurisdiction.",
    );
    // A short paragraph is shown whole, with no misleading ellipsis.
    const whole = excerptAround(paras, { paragraphIndex: 0, snippet: "Short" })!;
    expect(whole.before).toBe("");
    expect(whole.after).toBe(" line.");
  });

  it("cuts both sides when the field sits mid-paragraph", () => {
    const long = "x".repeat(200) + "[HERE]" + "y".repeat(200);
    const e = excerptAround([{ index: 0, text: long }], {
      paragraphIndex: 0,
      snippet: "[HERE]",
    })!;
    expect(e.before.startsWith("…")).toBe(true);
    expect(e.after.endsWith("…")).toBe(true);
  });

  it("returns null rather than guessing when the anchor no longer matches", () => {
    expect(excerptAround(paras, { paragraphIndex: 1, snippet: "text since edited" })).toBeNull();
    expect(excerptAround(paras, { paragraphIndex: 99, snippet: "Short" })).toBeNull();
    expect(excerptAround(paras, { paragraphIndex: 0, snippet: "" })).toBeNull();
  });
});

describe("contextLabel", () => {
  // "Design fee | Flat fee per phase | $[AMOUNT]" — the real fee table shape.
  const paras = [
    { index: 0, text: "Fee component" },
    { index: 1, text: "Basis" },
    { index: 2, text: "Amount / rate" },
    { index: 3, text: "Design fee" },
    { index: 4, text: "Flat fee per phase" },
    { index: 5, text: "$[AMOUNT]" },
    { index: 6, text: "Hourly — principal" },
    { index: 7, text: "Per hour" },
    { index: 8, text: "$[RATE]" },
    { index: 9, text: "Late fee: [AMOUNT]" },
    { index: 10, text: "This deposit of [AMOUNT] is due on signing." },
  ];
  const tables = [
    {
      startIndex: 0,
      rows: [
        [{ paragraphs: [0] }, { paragraphs: [1] }, { paragraphs: [2] }],
        [{ paragraphs: [3] }, { paragraphs: [4] }, { paragraphs: [5] }],
        [{ paragraphs: [6] }, { paragraphs: [7] }, { paragraphs: [8] }],
      ],
    },
  ];
  const marker = (paragraphIndex: number, text: string, start = 0) => ({
    text,
    paragraphIndex,
    start,
    end: start + text.length,
  });

  it("names a marker after its table row, appending the marker's word", () => {
    expect(contextLabel(marker(5, "[AMOUNT]", 1), paras, tables)).toBe("Design fee amount");
    expect(contextLabel(marker(8, "[RATE]", 1), paras, tables)).toBe("Hourly — principal rate");
  });

  it("does not repeat a word the row label already says", () => {
    const t = [{ startIndex: 0, rows: [[{ paragraphs: [3] }, { paragraphs: [5] }]] }];
    const p = [{ index: 3, text: "Design fee amount" }, { index: 5, text: "[AMOUNT]" }];
    expect(contextLabel(marker(5, "[AMOUNT]"), p, t)).toBe("Design fee amount");
  });

  it("gives a marker in the row's FIRST cell no context name", () => {
    const t = [{ startIndex: 0, rows: [[{ paragraphs: [5] }, { paragraphs: [3] }]] }];
    expect(contextLabel(marker(5, "[AMOUNT]", 1), paras, t)).toBeNull();
  });

  it("refuses a row label that is itself a placeholder", () => {
    const t = [{ startIndex: 0, rows: [[{ paragraphs: [10] }, { paragraphs: [5] }]] }];
    const p = [{ index: 10, text: "[Fee component]" }, { index: 5, text: "$[AMOUNT]" }];
    expect(contextLabel(marker(5, "[AMOUNT]", 1), p, t)).toBeNull();
  });

  it("reads a colon lead-in outside tables", () => {
    expect(contextLabel(marker(9, "[AMOUNT]", 10), paras, tables)).toBe("Late fee");
  });

  it("returns null mid-sentence — a wrong-but-plausible name is worse than an ugly one", () => {
    expect(contextLabel(marker(10, "[AMOUNT]", 16), paras, tables)).toBeNull();
  });

  it("reads pre-shading cells stored as bare paragraph arrays", () => {
    const t = [{ startIndex: 0, rows: [[[3], [5]] as number[][]] }];
    expect(contextLabel(marker(5, "[AMOUNT]", 1), paras, t)).toBe("Design fee amount");
  });
});
