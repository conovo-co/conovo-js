import { describe, expect, it } from "vitest";
import { usualValue } from "./usuals.js";
import type { SerializedValue } from "./values.js";

const money = (amount: string): SerializedValue => ({
  kind: "money",
  amount,
  currency: "USD",
});

describe("usualValue", () => {
  it("returns null with no history", () => {
    expect(usualValue([])).toBeNull();
  });

  it("picks the most frequently used value with its count", () => {
    const u = usualValue([
      { value: money("95"), at: "2026-01-01" },
      { value: money("95"), at: "2026-02-01" },
      { value: money("120"), at: "2026-03-01" },
    ]);
    expect(u).toEqual({ value: money("95"), count: 2 });
  });

  it("breaks a tie by recency — pricing drifts, the newer answer wins", () => {
    const u = usualValue([
      { value: money("95"), at: "2026-01-01" },
      { value: money("110"), at: "2026-06-01" },
    ]);
    expect(u).toEqual({ value: money("110"), count: 1 });
  });

  it("offers a single past use, honestly counted", () => {
    expect(usualValue([{ value: money("80"), at: "2026-01-01" }])).toEqual({
      value: money("80"),
      count: 1,
    });
  });

  it("groups by full value identity, not display text", () => {
    const u = usualValue([
      { value: { kind: "money", amount: "95", currency: "USD" }, at: 1 },
      { value: { kind: "money", amount: "95", currency: "EUR" }, at: 2 },
      { value: { kind: "money", amount: "95", currency: "EUR" }, at: 3 },
    ]);
    expect(u).toEqual({ value: { kind: "money", amount: "95", currency: "EUR" }, count: 2 });
  });

  it("survives an unparsable timestamp instead of throwing", () => {
    const u = usualValue([
      { value: money("95"), at: "not a date" },
      { value: money("120"), at: "2026-01-01" },
    ]);
    expect(u).toEqual({ value: money("120"), count: 1 });
  });
});
