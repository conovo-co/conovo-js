import { describe, expect, it } from "vitest";
import { findSignatureAnchors, type SignatureParty } from "./signatures.js";

/**
 * The rule these tests exist to protect: a WRONG anchor is worse than none.
 * A misplaced sign-here puts one party's signature on the other's line, in a
 * document with legal weight — so every ambiguous case must return nothing.
 */

const paras = (...lines: string[]) =>
  lines.map((text, index) => ({ index, text }));

const PARTIES: SignatureParty[] = [
  { key: "owner", label: "Owner", isSender: true },
  { key: "occupant", label: "Occupant", isSender: false },
];

describe("findSignatureAnchors", () => {
  it("matches each party to the signature line under its header", () => {
    const doc = paras(
      "STORAGE RENTAL AGREEMENT",
      "Body text that goes on for a while.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "OWNER:",
      "By: Casey Panzer",
      "OCCUPANT:",
      "By: ____________________",
    );
    const anchors = findSignatureAnchors(doc, PARTIES);
    expect(anchors).toEqual([
      { partyKey: "owner", paragraphIndex: 4, text: "By: Casey Panzer" },
      { partyKey: "occupant", paragraphIndex: 6, text: "By: ____________________" },
    ]);
  });

  it("never gives two parties the same line", () => {
    const doc = paras(
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "OWNER: OCCUPANT:",
      "By: ____________________",
    );
    const anchors = findSignatureAnchors(doc, PARTIES);
    const indexes = anchors.map((a) => a.paragraphIndex);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("falls back positionally only when the counts line up exactly", () => {
    // Two unlabeled signature lines, two parties → assign in document order.
    const even = paras(
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "By: ____________________",
      "By: ____________________",
    );
    expect(findSignatureAnchors(even, PARTIES).map((a) => a.partyKey)).toEqual([
      "owner",
      "occupant",
    ]);

    // Three lines, two parties → ambiguous, so nothing is placed.
    const uneven = paras(
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "By: ____________________",
      "By: ____________________",
      "By: ____________________",
    );
    expect(findSignatureAnchors(uneven, PARTIES)).toEqual([]);
  });

  it("returns nothing when the document has no signature lines", () => {
    const doc = paras("A memo with no execution block at all.", "Just prose.");
    expect(findSignatureAnchors(doc, PARTIES)).toEqual([]);
  });

  it("handles an empty document and an empty party list", () => {
    expect(findSignatureAnchors([], PARTIES)).toEqual([]);
    expect(findSignatureAnchors(paras("By: ___"), [])).toEqual([]);
  });

  it("finds the zone from the document tail when there's no witness clause", () => {
    const body = Array.from({ length: 20 }, (_, i) => `Clause ${i + 1} text.`);
    const doc = paras(...body, "OWNER:", "By: ____", "OCCUPANT:", "By: ____");
    const anchors = findSignatureAnchors(doc, PARTIES);
    expect(anchors.map((a) => a.partyKey)).toEqual(["owner", "occupant"]);
  });

  it("ignores earlier 'By:' lines outside the execution zone", () => {
    const doc = paras(
      "Payments must be made By: the first of each month.",
      ...Array.from({ length: 10 }, (_, i) => `Clause ${i}.`),
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "OWNER:",
      "By: ____",
      "OCCUPANT:",
      "By: ____",
    );
    const anchors = findSignatureAnchors(doc, PARTIES);
    expect(anchors.every((a) => a.paragraphIndex > 10)).toBe(true);
  });

  it("matches descriptive labels against the document's terse role word", () => {
    // Confirmed labels are written for the setup user; documents write the
    // bare role. This mismatch silently produced zero anchors on the first
    // real contract, so it stays covered.
    const descriptive: SignatureParty[] = [
      { key: "owner", label: "Owner (the storage facility business)", isSender: true },
      { key: "occupant", label: "Occupant (the renter)", isSender: false },
    ];
    const doc = paras(
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "OWNER:",
      "By: Casey Panzer",
      "OCCUPANT:",
      "By: ____________________",
    );
    expect(findSignatureAnchors(doc, descriptive)).toEqual([
      { partyKey: "owner", paragraphIndex: 2, text: "By: Casey Panzer" },
      { partyKey: "occupant", paragraphIndex: 4, text: "By: ____________________" },
    ]);
  });

  it("places one party when only that party is being sent to", () => {
    // Single-recipient sends are the common case — the other party is the
    // sender, countersigning outside the envelope.
    const doc = paras(
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "OWNER:",
      "By: Casey Panzer",
      "OCCUPANT:",
      "By: ____________________",
    );
    const occupantOnly: SignatureParty[] = [
      { key: "occupant", label: "Occupant (the renter)", isSender: false },
    ];
    expect(findSignatureAnchors(doc, occupantOnly)).toEqual([
      { partyKey: "occupant", paragraphIndex: 4, text: "By: ____________________" },
    ]);
  });

  it("matches a party whose header IS the signature line", () => {
    const doc = paras(
      "IN WITNESS WHEREOF, the parties have executed this Agreement.",
      "Owner: ____________________",
      "Occupant: ____________________",
    );
    const anchors = findSignatureAnchors(doc, PARTIES);
    expect(anchors).toEqual([
      { partyKey: "owner", paragraphIndex: 1, text: "Owner: ____________________" },
      { partyKey: "occupant", paragraphIndex: 2, text: "Occupant: ____________________" },
    ]);
  });
});
