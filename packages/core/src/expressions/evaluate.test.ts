import { describe, expect, it } from "vitest";
import { evaluateExpression, type EvalContext } from "./evaluate.js";
import { evaluateFormulas } from "./index.js";
import { parseExpression } from "./parser.js";
import { numberToWords } from "./spellOut.js";
import {
  bool,
  date,
  Decimal,
  DivisionByZeroError,
  formatMoney,
  money,
  num,
  text,
  toDisplayString,
  TypeMismatchError,
  UnresolvedError,
  type Value,
} from "./value.js";

const CTX: EvalContext = {
  today: "2026-07-07",
  sentDate: "2026-07-07",
  fields: {
    total_fee: money("4500"),
    deposit: money("2250"),
    start_date: date("2026-08-03"),
    client_name: text("Sarah Chen"),
    deposit_required: bool(true),
    revisions: num(2),
  },
  groups: {
    payment_schedule: [
      { amount: money("2000"), label: text("Kickoff") },
      { amount: money("1500"), label: text("Concepts") },
      { amount: money("1000"), label: text("Delivery") },
    ],
  },
};

const run = (src: string, ctx: EvalContext = CTX): Value =>
  evaluateExpression(parseExpression(src), ctx);

const asMoney = (v: Value): string => {
  if (v.kind !== "money") throw new Error(`expected money, got ${v.kind}`);
  return formatMoney(v.amount, v.currency);
};

describe("arithmetic (decimal-safe)", () => {
  it("never does binary-float math", () => {
    const v = run("0.1 + 0.2");
    expect(v.kind === "number" && v.value.eq(new Decimal("0.3"))).toBe(true);
  });

  it("percent sugar", () => {
    expect(asMoney(run("50% * total_fee"))).toBe("$2,250.00");
  });

  it("money arithmetic and ratios", () => {
    expect(asMoney(run("total_fee - deposit"))).toBe("$2,250.00");
    expect(asMoney(run("total_fee / 3"))).toBe("$1,500.00");
    const ratio = run("deposit / total_fee");
    expect(ratio.kind === "number" && ratio.value.eq(0.5)).toBe(true);
  });

  it("rejects money × money", () => {
    expect(() => run("total_fee * deposit")).toThrow(TypeMismatchError);
  });

  it("rejects currency mixing", () => {
    const ctx: EvalContext = {
      ...CTX,
      fields: { ...CTX.fields, eur: money("100", "EUR") },
    };
    expect(() => run("total_fee + eur", ctx)).toThrow(TypeMismatchError);
  });

  it("division by zero is an error, never Infinity", () => {
    expect(() => run("total_fee / 0")).toThrow(DivisionByZeroError);
    expect(() => run("1 / (2 - 2)")).toThrow(DivisionByZeroError);
  });

  it("unary minus", () => {
    expect(asMoney(run("-deposit"))).toBe("-$2,250.00");
  });
});

describe("rounding", () => {
  it("round() uses banker's rounding", () => {
    const r = (s: string) => {
      const v = run(s);
      return v.kind === "number" ? v.value.toString() : "?";
    };
    expect(r("round(2.5)")).toBe("2");
    expect(r("round(3.5)")).toBe("4");
    expect(r("round(2.345, 2)")).toBe("2.34");
  });

  it("abs()", () => {
    expect(asMoney(run("abs(deposit - total_fee)"))).toBe("$2,250.00");
  });
});

describe("comparisons and logic", () => {
  it("compares money, dates, numbers", () => {
    expect(run("total_fee > $4,000.00")).toEqual(bool(true));
    expect(run("start_date >= today()")).toEqual(bool(true));
    expect(run("revisions = 2")).toEqual(bool(true));
    expect(run('client_name != "Bob"')).toEqual(bool(true));
  });

  it("rejects cross-kind comparison", () => {
    expect(() => run("total_fee > 4000")).toThrow(TypeMismatchError);
  });

  it("and/or short-circuit; if() is lazy", () => {
    // right side would divide by zero if evaluated
    expect(run("false and 1 / 0 = 1")).toEqual(bool(false));
    expect(run("true or 1 / 0 = 1")).toEqual(bool(true));
    expect(asMoney(run("if(deposit_required, deposit, deposit / 0)"))).toBe(
      "$2,250.00",
    );
  });

  it("conditional money example from the spec", () => {
    // Jul 7 → Aug 3 is 27 days: inside the 28-day rush window
    expect(
      asMoney(run("if(daysBetween(sentDate(), start_date) < 28, $200, $0)")),
    ).toBe("$200.00");
  });
});

describe("aggregates over repeating groups", () => {
  it("sum reconciles with total", () => {
    expect(run("sum(payment_schedule.amount) = total_fee")).toEqual(bool(true));
  });

  it("count/min/max/avg", () => {
    expect(run("count(payment_schedule)")).toEqual(num(3));
    expect(asMoney(run("min(payment_schedule.amount)"))).toBe("$1,000.00");
    expect(asMoney(run("max(payment_schedule.amount)"))).toBe("$2,000.00");
    expect(asMoney(run("avg(payment_schedule.amount)"))).toBe("$1,500.00");
  });

  it("sum of empty list is zero", () => {
    const ctx: EvalContext = { ...CTX, groups: { payment_schedule: [] } };
    expect(run("sum(payment_schedule.amount)", ctx)).toEqual(num(0));
  });
});

describe("dates", () => {
  it("addWeeks / addDays / addMonths", () => {
    expect(run("addWeeks(start_date, 6)")).toEqual(date("2026-09-14"));
    expect(run("addDays(start_date, 1)")).toEqual(date("2026-08-04"));
    expect(run("addMonths(start_date, 1)")).toEqual(date("2026-09-03"));
  });

  it("businessDays skips weekends", () => {
    // 2026-08-03 is a Monday; +5 business days = next Monday
    expect(run("businessDays(start_date, 5)")).toEqual(date("2026-08-10"));
  });

  it("daysBetween is directional (b - a)", () => {
    expect(run("daysBetween(sentDate(), start_date)")).toEqual(num(27));
    expect(run("daysBetween(start_date, sentDate())")).toEqual(num(-27));
  });

  it("expiry() offsets from sentDate", () => {
    expect(run("expiry(14)")).toEqual(date("2026-07-21"));
  });
});

describe("text derivations", () => {
  it("spellOut produces the legal form", () => {
    expect(run("spellOut(total_fee)")).toEqual(
      text("Four Thousand Five Hundred Dollars ($4,500.00)"),
    );
    const ctx: EvalContext = {
      ...CTX,
      fields: { ...CTX.fields, odd: money("1.01") },
    };
    expect(run("spellOut(odd)", ctx)).toEqual(
      text("One Dollar and One Cent ($1.01)"),
    );
  });

  it("numberToWords handles scales and teens", () => {
    expect(numberToWords(0)).toBe("Zero");
    expect(numberToWords(17)).toBe("Seventeen");
    expect(numberToWords(42)).toBe("Forty-Two");
    expect(numberToWords(105)).toBe("One Hundred Five");
    expect(numberToWords(12_500_000)).toBe("Twelve Million Five Hundred Thousand");
  });

  it("pluralize", () => {
    expect(run('pluralize(revisions, "revision")')).toEqual(text("2 revisions"));
    expect(run('pluralize(1, "week")')).toEqual(text("1 week"));
  });

  it("formatDate styles", () => {
    expect(run("formatDate(start_date)")).toEqual(text("August 3, 2026"));
    expect(run('formatDate(start_date, "short")')).toEqual(text("08/03/2026"));
    expect(run('formatDate(start_date, "iso")')).toEqual(text("2026-08-03"));
  });

  it("concat renders display strings", () => {
    expect(run('concat("Total: ", total_fee, " due ", start_date)')).toEqual(
      text("Total: $4,500.00 due August 3, 2026"),
    );
  });
});

describe("split() — exactness property", () => {
  const sumOf = (v: Value): Decimal => {
    if (v.kind !== "list") throw new Error("expected list");
    return v.items.reduce(
      (acc, i) => (i.kind === "money" ? acc.plus(i.amount) : acc),
      new Decimal(0),
    );
  };

  it("always sums exactly to the total, remainder cents to first share", () => {
    const ctx: EvalContext = {
      ...CTX,
      fields: { ...CTX.fields, awkward: money("100.01") },
    };
    const v = run("split(awkward, 3)", ctx);
    expect(sumOf(v).eq(new Decimal("100.01"))).toBe(true);
    if (v.kind === "list" && v.items[0]?.kind === "money") {
      expect(v.items[0].amount.toFixed(2)).toBe("33.35");
    }
  });

  it("property: split(x, n) sums to x for many x and n", () => {
    for (const cents of [1, 7, 99, 100, 101, 4500_00, 123456_78, 999999_99]) {
      for (const n of [1, 2, 3, 4, 7, 12]) {
        const amount = new Decimal(cents).div(100);
        const ctx: EvalContext = {
          ...CTX,
          fields: { total: money(amount) },
        };
        const v = run(`split(total, ${n})`, ctx);
        expect(sumOf(v).eq(amount)).toBe(true);
        if (v.kind === "list") expect(v.items).toHaveLength(n);
      }
    }
  });
});

describe("null propagation", () => {
  it("unresolved refs throw UnresolvedError (never coerce)", () => {
    expect(() => run("missing_field + 1")).toThrow(UnresolvedError);
  });

  it("evaluateFormulas: unresolved inputs cascade to dependents", () => {
    const result = evaluateFormulas(
      {
        deposit: "50% * total_fee",
        balance: "total_fee - deposit",
        fee_words: "spellOut(total_fee)",
      },
      { today: "2026-07-07", sentDate: "2026-07-07", fields: {} }, // no total_fee
    );
    expect(Object.keys(result.values)).toHaveLength(0);
    expect(result.unresolved["deposit"]).toEqual(["total_fee"]);
    expect(result.unresolved["balance"]).toBeDefined();
    expect(result.unresolved["fee_words"]).toEqual(["total_fee"]);
  });
});

describe("evaluateFormulas — the spec's worked example end to end", () => {
  it("fee → deposit → balance → words, in order, exactly", () => {
    const result = evaluateFormulas(
      {
        deposit: "50% * total_fee",
        balance: "total_fee - deposit",
        end_date: "addWeeks(start_date, 6)",
        rush_fee: "if(daysBetween(sentDate(), start_date) < 28, $200, $0)",
        fee_words: "spellOut(total_fee)",
        schedule_ok: "sum(payment_schedule.amount) = total_fee",
      },
      CTX,
    );

    expect(result.errors).toEqual({});
    expect(result.unresolved).toEqual({});
    expect(asMoney(result.values["deposit"]!)).toBe("$2,250.00");
    expect(asMoney(result.values["balance"]!)).toBe("$2,250.00");
    expect(result.values["end_date"]).toEqual(date("2026-09-14"));
    expect(asMoney(result.values["rush_fee"]!)).toBe("$200.00"); // 27 days out
    expect(result.values["fee_words"]).toEqual(
      text("Four Thousand Five Hundred Dollars ($4,500.00)"),
    );
    expect(result.values["schedule_ok"]).toEqual(bool(true));
    expect(result.order.indexOf("deposit")).toBeLessThan(
      result.order.indexOf("balance"),
    );
  });

  it("division-by-zero lands in errors, not values", () => {
    const result = evaluateFormulas(
      { bad: "total_fee / (revisions - 2)" },
      CTX,
    );
    expect(result.values["bad"]).toBeUndefined();
    expect(result.errors["bad"]).toMatch(/division by zero/);
  });
});

describe("display strings", () => {
  it("toDisplayString covers all kinds", () => {
    expect(toDisplayString(money("4500"))).toBe("$4,500.00");
    expect(toDisplayString(date("2026-03-03"))).toBe("March 3, 2026");
    expect(toDisplayString({ kind: "duration", n: 1, unit: "weeks" })).toBe("1 week");
    expect(toDisplayString({ kind: "duration", n: 6, unit: "weeks" })).toBe("6 weeks");
  });
});
