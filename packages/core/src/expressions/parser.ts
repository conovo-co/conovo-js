import type { Ast, BinOp } from "./ast.js";
import { tokenize, type Token } from "./lexer.js";
import { ParseError, type DurationUnit } from "./value.js";

/**
 * Recursive-descent parser for docs/EXPRESSIONS.md. Precedence (low → high):
 * or < and < not < comparison < additive < multiplicative < unary minus.
 */

const DURATION_UNITS: Record<string, DurationUnit> = {
  day: "days", days: "days",
  week: "weeks", weeks: "weeks",
  month: "months", months: "months",
  year: "years", years: "years",
};

const COMPARISONS = new Set(["=", "!=", "<", "<=", ">", ">="]);

export function parseExpression(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const t = tokens[pos];
    if (!t) throw new ParseError("unexpected end of expression", src.length);
    pos++;
    return t;
  };
  const isOp = (t: Token | undefined, ...ops: string[]): boolean =>
    t !== undefined && t.type === "op" && ops.includes(t.value);
  const expectOp = (op: string): void => {
    const t = next();
    if (t.type !== "op" || t.value !== op)
      throw new ParseError(`expected "${op}"`, t.pos);
  };

  function parseOr(): Ast {
    let left = parseAnd();
    while (peek()?.type === "ident" && peek()!.value === "or") {
      next();
      left = { t: "binary", op: "or", left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): Ast {
    let left = parseNot();
    while (peek()?.type === "ident" && peek()!.value === "and") {
      next();
      left = { t: "binary", op: "and", left, right: parseNot() };
    }
    return left;
  }

  function parseNot(): Ast {
    if (peek()?.type === "ident" && peek()!.value === "not") {
      next();
      return { t: "unary", op: "not", operand: parseNot() };
    }
    return parseComparison();
  }

  function parseComparison(): Ast {
    const left = parseAdditive();
    const t = peek();
    if (t?.type === "op" && COMPARISONS.has(t.value)) {
      next();
      return {
        t: "binary",
        op: t.value as BinOp,
        left,
        right: parseAdditive(),
      };
    }
    return left;
  }

  function parseAdditive(): Ast {
    let left = parseMultiplicative();
    while (isOp(peek(), "+", "-")) {
      const op = next().value as BinOp;
      left = { t: "binary", op, left, right: parseMultiplicative() };
    }
    return left;
  }

  function parseMultiplicative(): Ast {
    let left = parseUnary();
    while (isOp(peek(), "*", "/")) {
      const op = next().value as BinOp;
      left = { t: "binary", op, left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary(): Ast {
    if (isOp(peek(), "-")) {
      next();
      return { t: "unary", op: "-", operand: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Ast {
    const t = next();

    if (t.type === "money") return { t: "money", value: t.value, currency: "USD" };
    if (t.type === "string") return { t: "text", value: t.value };

    if (t.type === "number") {
      // percent sugar: 50%  → num(percent)
      if (isOp(peek(), "%")) {
        next();
        return { t: "num", value: t.value, percent: true };
      }
      // duration literal: 6 weeks
      const unitTok = peek();
      if (unitTok?.type === "ident" && DURATION_UNITS[unitTok.value] !== undefined) {
        next();
        const n = Number(t.value);
        if (!Number.isInteger(n))
          throw new ParseError("duration count must be a whole number", t.pos);
        return { t: "duration", n, unit: DURATION_UNITS[unitTok.value]! };
      }
      return { t: "num", value: t.value, percent: false };
    }

    if (t.type === "ident") {
      if (t.value === "true") return { t: "bool", value: true };
      if (t.value === "false") return { t: "bool", value: false };
      if (t.value === "and" || t.value === "or" || t.value === "not")
        throw new ParseError(`unexpected "${t.value}"`, t.pos);

      // call: name(args)
      if (isOp(peek(), "(")) {
        next();
        const args: Ast[] = [];
        if (!isOp(peek(), ")")) {
          args.push(parseOr());
          while (isOp(peek(), ",")) {
            next();
            args.push(parseOr());
          }
        }
        expectOp(")");
        return { t: "call", name: t.value, args };
      }

      // column ref: group.column
      if (isOp(peek(), ".")) {
        next();
        const col = next();
        if (col.type !== "ident")
          throw new ParseError("expected column name after '.'", col.pos);
        return { t: "ref", name: t.value, column: col.value };
      }

      return { t: "ref", name: t.value };
    }

    // t.type === "op"
    if (t.value === "(") {
      const inner = parseOr();
      expectOp(")");
      return inner;
    }

    throw new ParseError(`unexpected "${t.value}"`, t.pos);
  }

  const ast = parseOr();
  const trailing = peek();
  if (trailing !== undefined)
    throw new ParseError(
      `unexpected trailing input "${trailing.type === "op" ? trailing.value : trailing.value}"`,
      trailing.pos,
    );
  return ast;
}
