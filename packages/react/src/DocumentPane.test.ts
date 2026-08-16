import { describe, expect, it } from "vitest";
import { normaliseCell, segmentText } from "./DocumentPane.js";

/**
 * doc_structure is a SNAPSHOT of the document a template was cut from, written
 * at import time and never rewritten. So every shape it has ever had is still
 * in the database, and the reader has to accept all of them.
 *
 * This is regression cover for a real crash: cells were stored as a bare
 * number[] before shading was added, the type moved to {paragraphs, shade},
 * and the renderer threw "t.paragraphs is not iterable" on every document
 * written in between.
 */
describe("normaliseCell", () => {
  it("reads the current shape unchanged", () => {
    expect(normaliseCell({ paragraphs: [1, 2], shade: "F4F1EB" })).toEqual({
      paragraphs: [1, 2],
      shade: "F4F1EB",
    });
  });

  it("reads the pre-shading shape, a bare array of paragraph indices", () => {
    expect(normaliseCell([3, 4])).toEqual({ paragraphs: [3, 4] });
  });

  it("survives a cell it doesn't recognise instead of throwing", () => {
    // An empty cell renders visibly wrong; an exception takes down the page.
    expect(normaliseCell(null)).toEqual({ paragraphs: [] });
    expect(normaliseCell(undefined)).toEqual({ paragraphs: [] });
    expect(normaliseCell({} as never)).toEqual({ paragraphs: [] });
    expect(normaliseCell({ paragraphs: "nope" } as never)).toEqual({ paragraphs: [] });
  });

  it("keeps an empty cell empty rather than inventing content", () => {
    expect(normaliseCell([])).toEqual({ paragraphs: [] });
    expect(normaliseCell({ paragraphs: [] })).toEqual({ paragraphs: [] });
  });
});

describe("segmentText", () => {
  // "Fee: $4,500 total" — mark over "$4,500", bold run over "Fee:".
  it("cuts at both mark and run boundaries", () => {
    const bold = { start: 0, end: 4, bold: true };
    expect(segmentText(17, [{ start: 5, end: 11, key: "fee" }], [bold])).toEqual([
      { start: 0, end: 4, run: bold },
      { start: 4, end: 5 },
      { start: 5, end: 11, key: "fee" },
      { start: 11, end: 17 },
    ]);
  });

  it("drapes a run across a mark without splitting the mark", () => {
    // Bold covers the whole text; the mark sits inside it. Both segments of
    // the mark carry the run, and the renderer groups them into ONE <mark>.
    const bold = { start: 0, end: 10, bold: true };
    expect(segmentText(10, [{ start: 2, end: 6, key: "k" }], [bold])).toEqual([
      { start: 0, end: 2, run: bold },
      { start: 2, end: 6, key: "k", run: bold },
      { start: 6, end: 10, run: bold },
    ]);
  });

  it("splits a mark crossed by a formatting boundary into same-key segments", () => {
    // "1.1 Services. Designer" with bold ending inside the mark: the mark's
    // slices stay adjacent and share the key, so they regroup into one mark.
    const segs = segmentText(
      22,
      [{ start: 4, end: 22, key: "k" }],
      [{ start: 0, end: 13, bold: true }],
    );
    expect(segs).toEqual([
      { start: 0, end: 4, run: { start: 0, end: 13, bold: true } },
      { start: 4, end: 13, key: "k", run: { start: 0, end: 13, bold: true } },
      { start: 13, end: 22, key: "k" },
    ]);
  });

  it("covers plain text with no spans at all", () => {
    expect(segmentText(5, [], [])).toEqual([{ start: 0, end: 5 }]);
  });

  it("clamps a run written past the end of the text — persisted data", () => {
    expect(segmentText(4, [], [{ start: 2, end: 9, italic: true }])).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4, run: { start: 2, end: 9, italic: true } },
    ]);
  });

  it("returns nothing for empty text rather than a zero-width segment", () => {
    expect(segmentText(0, [], [])).toEqual([]);
  });
});
