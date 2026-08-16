import { describe, expect, it } from "vitest";
import {
  Decimal,
  TypeMismatchError,
  bool,
  date,
  duration,
  list,
  money,
  num,
  text,
} from "./expressions/value.js";
import {
  coercePayloadValue,
  deserializeValue,
  parseValueInput,
  serializedValueSchema,
  serializeValue,
  valueKindForType,
} from "./values.js";

describe("serializeValue / deserializeValue", () => {
  const cases = [
    num("4500.5"),
    num("-0.125"),
    money("4500", "USD"),
    money("0.1", "EUR"),
    date("2026-08-03"),
    duration(30, "days"),
    text("Net 30"),
    bool(true),
    list([money("100"), text("a"), list([num(1)])]),
  ];

  it("round-trips every kind", () => {
    for (const v of cases) {
      expect(deserializeValue(serializeValue(v))).toEqual(v);
    }
  });

  it("produces JSON that validates against serializedValueSchema", () => {
    for (const v of cases) {
      const json = JSON.parse(JSON.stringify(serializeValue(v))) as unknown;
      expect(serializedValueSchema.safeParse(json).success).toBe(true);
    }
  });

  it("serializes decimals as canonical strings, never floats", () => {
    expect(serializeValue(money("4500.10"))).toEqual({
      kind: "money",
      amount: "4500.1",
      currency: "USD",
    });
    expect(serializeValue(num(new Decimal("1e3")))).toEqual({
      kind: "number",
      value: "1000",
    });
  });

  it("rejects malformed serialized values", () => {
    expect(serializedValueSchema.safeParse({ kind: "money", amount: "1e3", currency: "USD" }).success).toBe(false);
    expect(serializedValueSchema.safeParse({ kind: "date", iso: "8/3/2026" }).success).toBe(false);
    expect(serializedValueSchema.safeParse({ kind: "duration", n: 1.5, unit: "days" }).success).toBe(false);
    expect(serializedValueSchema.safeParse({ kind: "nope", value: "x" }).success).toBe(false);
  });
});

describe("valueKindForType", () => {
  it("maps scalar types and rejects structured ones", () => {
    expect(valueKindForType("money")).toBe("money");
    expect(valueKindForType("long_text")).toBe("text");
    expect(valueKindForType("choice")).toBe("text");
    expect(valueKindForType("party")).toBeNull();
    expect(valueKindForType("repeating_group")).toBeNull();
    expect(valueKindForType("exhibit")).toBeNull();
  });
});

describe("parseValueInput", () => {
  it("parses money with $, commas, and decimals", () => {
    expect(parseValueInput("money", "$4,500.00")).toEqual(money("4500"));
    expect(parseValueInput("money", "4500")).toEqual(money("4500"));
    expect(parseValueInput("money", " $ 250 ")).toEqual(money("250"));
  });

  it("rejects non-amounts for money", () => {
    expect(() => parseValueInput("money", "about 4500")).toThrow(TypeMismatchError);
    expect(() => parseValueInput("money", "4,50.00")).toThrow(TypeMismatchError);
  });

  it("parses numbers, including percent shorthand", () => {
    expect(parseValueInput("number", "1,250.5")).toEqual(num("1250.5"));
    expect(parseValueInput("number", "50%")).toEqual(num("0.5"));
    expect(parseValueInput("number", "-3")).toEqual(num("-3"));
  });

  it("parses ISO and long-form dates", () => {
    expect(parseValueInput("date", "2026-08-03")).toEqual(date("2026-08-03"));
    expect(parseValueInput("date", "August 3, 2026")).toEqual(date("2026-08-03"));
    expect(parseValueInput("date", "march 15 2027")).toEqual(date("2027-03-15"));
    expect(() => parseValueInput("date", "8/3/2026")).toThrow(TypeMismatchError);
  });

  it("parses durations", () => {
    expect(parseValueInput("duration", "30 days")).toEqual(duration(30, "days"));
    expect(parseValueInput("duration", "1 Month")).toEqual(duration(1, "months"));
    expect(() => parseValueInput("duration", "soon")).toThrow(TypeMismatchError);
  });

  it("treats text-ish types as text", () => {
    expect(parseValueInput("address", "142 Beacon St, Boston MA")).toEqual(
      text("142 Beacon St, Boston MA"),
    );
    expect(parseValueInput("name", "Leigh H Designs")).toEqual(text("Leigh H Designs"));
  });

  it("rejects empty input and structured types", () => {
    expect(() => parseValueInput("text", "   ")).toThrow(TypeMismatchError);
    expect(() => parseValueInput("party", "Acme LLC")).toThrow(TypeMismatchError);
  });
});

describe("coercePayloadValue", () => {
  it("coerces payload numbers as major units", () => {
    expect(coercePayloadValue("money", 4500)).toEqual(money("4500"));
    expect(coercePayloadValue("number", 0.5)).toEqual(num("0.5"));
  });

  it("coerces payload strings through input parsing", () => {
    expect(coercePayloadValue("money", "$1,200.50")).toEqual(money("1200.5"));
    expect(coercePayloadValue("date", "2026-08-03")).toEqual(date("2026-08-03"));
    expect(coercePayloadValue("duration", "2 weeks")).toEqual(duration(2, "weeks"));
  });

  it("stringifies scalars for text-ish fields", () => {
    expect(coercePayloadValue("name", "Sarah Chen")).toEqual(text("Sarah Chen"));
    expect(coercePayloadValue("text", 42)).toEqual(text("42"));
  });

  it("throws on missing or dishonest values", () => {
    expect(() => coercePayloadValue("money", null)).toThrow(TypeMismatchError);
    expect(() => coercePayloadValue("money", "call for pricing")).toThrow(TypeMismatchError);
    expect(() => coercePayloadValue("date", 20260803)).toThrow(TypeMismatchError);
    expect(() => coercePayloadValue("repeating_group", [1, 2])).toThrow(TypeMismatchError);
  });
});
