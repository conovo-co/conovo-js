import { describe, expect, it } from "vitest";
import { detectDeviation, detectDeviations } from "./deviation.js";
import type { SerializedValue } from "./values.js";
import type { UsualObservation } from "./usuals.js";

/**
 * The behaviour that matters: catch the mis-mapped field (a plausible number
 * from the wrong place) WITHOUT crying wolf on normal business variation.
 * A chip nobody trusts is worse than no chip.
 */

const money = (amount: string): SerializedValue => ({
  kind: "money",
  amount,
  currency: "USD",
});
const text = (value: string): SerializedValue => ({ kind: "text", value });

const history = (values: SerializedValue[]): UsualObservation[] =>
  values.map((value, i) => ({ value, at: 1_700_000_000_000 + i * 86_400_000 }));

describe("detectDeviation — amounts", () => {
  it("flags the mis-mapped field: a project budget where a retainer belongs", () => {
    const past = history(Array.from({ length: 38 }, () => money("150.00")));
    const flag = detectDeviation("retainer", money("4500.00"), past);
    expect(flag).toMatchObject({ fieldKey: "retainer", kind: "amount", usualCount: 38 });
  });

  it("stays quiet on ordinary variation around the usual", () => {
    const past = history(
      ["150.00", "175.00", "150.00", "200.00", "165.00", "150.00"].map(money),
    );
    expect(detectDeviation("rate", money("185.00"), past)).toBeNull();
  });

  it("stays quiet when there isn't enough history to have a usual", () => {
    const past = history([money("150.00"), money("150.00")]);
    expect(detectDeviation("rate", money("9999.00"), past)).toBeNull();
  });

  it("flags a materially different amount when every past contract agreed", () => {
    const past = history(Array.from({ length: 10 }, () => money("500.00")));
    expect(detectDeviation("deposit", money("5000.00"), past)).not.toBeNull();
    // …but not a rounding-level difference on that settled number.
    expect(detectDeviation("deposit", money("505.00"), past)).toBeNull();
    // …and not the usual itself.
    expect(detectDeviation("deposit", money("500.00"), past)).toBeNull();
  });

  it("reports how far off it is, for honest copy", () => {
    const past = history(
      ["100.00", "110.00", "105.00", "100.00", "115.00", "108.00"].map(money),
    );
    const flag = detectDeviation("fee", money("9000.00"), past);
    expect(flag?.deviations).toBeGreaterThan(6);
  });
});

describe("detectDeviation — non-numeric", () => {
  it("flags a replaced value only when the old one dominated", () => {
    const dominant = history([
      ...Array.from({ length: 9 }, () => text("Net 30")),
      text("Net 15"),
    ]);
    expect(detectDeviation("terms", text("Due on receipt"), dominant)).toMatchObject({
      kind: "different",
      usualCount: 9,
    });

    const mixed = history([
      text("Net 30"),
      text("Net 15"),
      text("Net 45"),
      text("Net 30"),
      text("Due on receipt"),
      text("Net 60"),
    ]);
    expect(detectDeviation("terms", text("Net 90"), mixed)).toBeNull();
  });

  it("says nothing when the value matches the usual", () => {
    const past = history(Array.from({ length: 8 }, () => text("Net 30")));
    expect(detectDeviation("terms", text("Net 30"), past)).toBeNull();
  });
});

describe("detectDeviations", () => {
  it("checks every field that has history and skips the rest", () => {
    const flags = detectDeviations(
      {
        retainer: money("4500.00"),
        rate: money("150.00"),
        unmapped: money("999.00"),
      },
      {
        retainer: history(Array.from({ length: 20 }, () => money("150.00"))),
        rate: history(Array.from({ length: 20 }, () => money("150.00"))),
      },
    );
    expect(flags.map((f) => f.fieldKey)).toEqual(["retainer"]);
  });
});
