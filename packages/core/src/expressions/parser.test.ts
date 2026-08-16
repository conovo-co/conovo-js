import { describe, expect, it } from "vitest";
import { parseExpression } from "./parser.js";
import { printExpression } from "./ast.js";
import { collectRefs, dependencies, topoSort } from "./analyze.js";
import { CycleError, ParseError } from "./value.js";

describe("parser", () => {
  it("parses precedence correctly (1 + 2 * 3)", () => {
    const ast = parseExpression("1 + 2 * 3");
    expect(ast).toMatchObject({
      t: "binary",
      op: "+",
      right: { t: "binary", op: "*" },
    });
  });

  it("parses percent sugar", () => {
    expect(parseExpression("50% * total_fee")).toMatchObject({
      t: "binary",
      op: "*",
      left: { t: "num", value: "50", percent: true },
      right: { t: "ref", name: "total_fee" },
    });
  });

  it("parses money literals with commas", () => {
    expect(parseExpression("$4,500.00")).toEqual({
      t: "money",
      value: "4500.00",
      currency: "USD",
    });
  });

  it("parses duration literals, singular and plural", () => {
    expect(parseExpression("6 weeks")).toEqual({ t: "duration", n: 6, unit: "weeks" });
    expect(parseExpression("1 week")).toEqual({ t: "duration", n: 1, unit: "weeks" });
  });

  it("parses column refs and calls", () => {
    expect(parseExpression("sum(payment_schedule.amount)")).toEqual({
      t: "call",
      name: "sum",
      args: [{ t: "ref", name: "payment_schedule", column: "amount" }],
    });
  });

  it("parses boolean operators with correct precedence", () => {
    const ast = parseExpression("a > 1 and not b = 2 or c");
    expect(ast).toMatchObject({ t: "binary", op: "or" });
  });

  it("parses nested calls and comparisons inside args", () => {
    const ast = parseExpression(
      'if(daysBetween(sentDate(), start_date) < 28, $200, $0)',
    );
    expect(ast).toMatchObject({ t: "call", name: "if" });
  });

  it("rejects garbage", () => {
    expect(() => parseExpression("1 +")).toThrow(ParseError);
    expect(() => parseExpression("(1 + 2")).toThrow(ParseError);
    expect(() => parseExpression("1 2")).toThrow(ParseError);
    expect(() => parseExpression("#foo")).toThrow(ParseError);
    expect(() => parseExpression('"unterminated')).toThrow(ParseError);
  });

  it("round-trips: parse(print(parse(src))) is stable", () => {
    const sources = [
      "50% * total_fee",
      "total_fee - deposit",
      "addWeeks(start_date, 6)",
      'if(total_fee > $10,000.00, split(total_fee, 3), split(total_fee, 2))',
      "sum(payment_schedule.amount) = total_fee",
      "not deposit_required and total_fee >= $500.00",
      "-balance + abs(adjustment)",
      'concat("Fee: ", spellOut(total_fee))',
      "6 weeks",
    ];
    for (const src of sources) {
      const once = parseExpression(src);
      const twice = parseExpression(printExpression(once));
      expect(twice).toEqual(once);
    }
  });
});

describe("analyze", () => {
  it("collects field and group refs", () => {
    const refs = collectRefs(
      parseExpression("sum(schedule.amount) + deposit - fee"),
    );
    expect([...refs.groups]).toEqual(["schedule"]);
    expect([...refs.fields].sort()).toEqual(["deposit", "fee"]);
  });

  it("dependencies unions fields and groups", () => {
    expect([...dependencies(parseExpression("sum(g.x) + a"))].sort()).toEqual([
      "a",
      "g",
    ]);
  });

  it("topo-sorts formulas by dependency", () => {
    const order = topoSort({
      fee_words: parseExpression("spellOut(total_fee)"),
      balance: parseExpression("total_fee - deposit"),
      deposit: parseExpression("50% * total_fee"),
    });
    expect(order.indexOf("deposit")).toBeLessThan(order.indexOf("balance"));
  });

  it("detects cycles with a readable path", () => {
    try {
      topoSort({
        a: parseExpression("b + 1"),
        b: parseExpression("a + 1"),
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CycleError);
      expect((err as CycleError).cycle.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("allows self-free diamond dependencies", () => {
    expect(() =>
      topoSort({
        d: parseExpression("b + c"),
        b: parseExpression("a * 2"),
        c: parseExpression("a * 3"),
      }),
    ).not.toThrow();
  });
});
