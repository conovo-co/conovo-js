import { describe, expect, it } from "vitest";
import { parseCsv, CsvError } from "./csv.js";
import { detectOutliers } from "./outliers.js";
import type { SerializedValue } from "./values.js";

describe("parseCsv", () => {
  it("parses plain rows with a header", () => {
    const { headers, rows } = parseCsv("name,email\nSarah,s@x.com\nBob,b@x.com\n");
    expect(headers).toEqual(["name", "email"]);
    expect(rows).toEqual([
      ["Sarah", "s@x.com"],
      ["Bob", "b@x.com"],
    ]);
  });

  it("handles quoted fields: commas, doubled quotes, embedded newlines", () => {
    const { rows } = parseCsv(
      'name,notes\n"Chen, Sarah","She said ""go""\nsecond line"\n',
    );
    expect(rows).toEqual([["Chen, Sarah", 'She said "go"\nsecond line']]);
  });

  it("handles CRLF and a UTF-8 BOM", () => {
    const { headers, rows } = parseCsv("﻿a,b\r\n1,2\r\n");
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([["1", "2"]]);
  });

  it("pads short rows and truncates long ones to the header width", () => {
    const { rows } = parseCsv("a,b,c\n1,2\n1,2,3,4\n");
    expect(rows).toEqual([
      ["1", "2", ""],
      ["1", "2", "3"],
    ]);
  });

  it("skips blank lines", () => {
    const { rows } = parseCsv("a,b\n\n1,2\n\n");
    expect(rows).toEqual([["1", "2"]]);
  });

  it("rejects malformed input loudly with a line number", () => {
    expect(() => parseCsv('a,b\n1,"unterminated\n')).toThrow(CsvError);
    expect(() => parseCsv("a,b\n1,mid\"quote\n")).toThrow(/line 2/);
    expect(() => parseCsv("")).toThrow(/no header/);
  });
});

const money = (amount: string): SerializedValue => ({
  kind: "money",
  amount,
  currency: "USD",
});

describe("detectOutliers", () => {
  it("flags the $200k fee among $2–5k fees", () => {
    const fees = ["2000", "3500", "4200", "2800", "5000", "3100", "200000"].map(money);
    const flags = detectOutliers({ fee: fees });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ fieldKey: "fee", itemIndex: 6, value: "200000" });
  });

  it("stays quiet on a normal spread", () => {
    const fees = ["2000", "3500", "4200", "2800", "5000", "3100"].map(money);
    expect(detectOutliers({ fee: fees })).toHaveLength(0);
  });

  it("flags any deviation when everyone else is identical (zero MAD)", () => {
    const fees = ["100", "100", "100", "100", "250"].map(money);
    const flags = detectOutliers({ fee: fees });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.itemIndex).toBe(4);
  });

  it("needs a minimum sample and skips unresolved holes", () => {
    expect(detectOutliers({ fee: ["1", "999999"].map(money) })).toHaveLength(0);
    const withHoles = [money("2000"), undefined, money("2100"), money("1900"), money("2050")];
    expect(detectOutliers({ fee: withHoles })).toHaveLength(0);
  });

  it("ignores non-numeric kinds", () => {
    const texts: SerializedValue[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "text",
      value: `note ${i}`,
    }));
    expect(detectOutliers({ notes: texts })).toHaveLength(0);
  });
});
