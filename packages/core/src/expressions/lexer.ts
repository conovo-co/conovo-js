import { ParseError } from "./value.js";

export type Token =
  | { type: "number"; value: string; pos: number }
  | { type: "money"; value: string; pos: number }
  | { type: "string"; value: string; pos: number }
  | { type: "ident"; value: string; pos: number }
  | { type: "op"; value: string; pos: number } // + - * / = != < <= > >= % ( ) , .
  ;

const MULTI_OPS = ["!=", "<=", ">="];
const SINGLE_OPS = new Set(["+", "-", "*", "/", "=", "<", ">", "%", "(", ")", ",", "."]);

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Money literal: $4,500.00 — commas only as proper thousands grouping,
    // so an argument-separator comma after "$200," is never swallowed
    if (ch === "$") {
      const m = /^\$((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/.exec(src.slice(i));
      if (!m) throw new ParseError("expected amount after '$'", i);
      tokens.push({ type: "money", value: m[1]!.replace(/,/g, ""), pos: i });
      i += m[0].length;
      continue;
    }

    // Number literal (no commas — commas are argument separators)
    if (/\d/.test(ch)) {
      const m = /^\d+(?:\.\d+)?/.exec(src.slice(i))!;
      tokens.push({ type: "number", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }

    // String literal
    if (ch === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(src.slice(i));
      if (!m) throw new ParseError("unterminated string", i);
      tokens.push({
        type: "string",
        value: m[1]!.replace(/\\(.)/g, "$1"),
        pos: i,
      });
      i += m[0].length;
      continue;
    }

    // Identifier / keyword
    if (/[a-zA-Z_]/.test(ch)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))!;
      tokens.push({ type: "ident", value: m[0], pos: i });
      i += m[0].length;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (SINGLE_OPS.has(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }

    throw new ParseError(`unexpected character "${ch}"`, i);
  }

  return tokens;
}
