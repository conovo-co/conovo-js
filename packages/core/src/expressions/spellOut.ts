import { Decimal, formatMoney, TypeMismatchError } from "./value.js";

/**
 * Legal spelled-out money: "Four Thousand Five Hundred Dollars ($4,500.00)",
 * "One Dollar and One Cent ($1.01)". Deterministic formatting code — never AI.
 */

const ONES = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight",
  "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen",
  "Sixteen", "Seventeen", "Eighteen", "Nineteen",
] as const;

const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy",
  "Eighty", "Ninety",
] as const;

const SCALES = ["", " Thousand", " Million", " Billion", " Trillion"] as const;

function threeDigits(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest >= 20) {
    const tens = TENS[Math.floor(rest / 10)]!;
    const ones = rest % 10;
    parts.push(ones > 0 ? `${tens}-${ONES[ones]}` : tens);
  } else if (rest > 0) {
    parts.push(ONES[rest]!);
  }
  return parts.join(" ");
}

export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0)
    throw new TypeMismatchError("numberToWords expects a non-negative integer");
  if (n === 0) return "Zero";
  if (n >= 1_000_000_000_000_000)
    throw new TypeMismatchError("numberToWords: value too large");

  const groups: string[] = [];
  let remaining = n;
  let scale = 0;
  while (remaining > 0) {
    const group = remaining % 1000;
    if (group > 0) groups.unshift(`${threeDigits(group)}${SCALES[scale]}`);
    remaining = Math.floor(remaining / 1000);
    scale++;
  }
  return groups.join(" ");
}

export function spellOutMoney(amount: Decimal, currency: string): string {
  const negative = amount.isNegative();
  const abs = amount.abs().toDecimalPlaces(2); // ROUND_HALF_EVEN (global config)
  const dollars = abs.floor().toNumber();
  const cents = abs.minus(abs.floor()).times(100).round().toNumber();

  const unit = currency === "USD" ? "Dollar" : currency;
  const dollarWords = `${numberToWords(dollars)} ${unit}${dollars === 1 ? "" : "s"}`;
  const centWords =
    cents > 0 ? ` and ${numberToWords(cents)} Cent${cents === 1 ? "" : "s"}` : "";
  const prefix = negative ? "Negative " : "";

  return `${prefix}${dollarWords}${centWords} (${formatMoney(amount, currency)})`;
}
