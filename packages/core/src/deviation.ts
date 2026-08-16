import Decimal from "decimal.js";
import type { SerializedValue } from "./values.js";
import type { UsualObservation } from "./usuals.js";

/**
 * Deviation check (SPEC §3.4.6): "this doesn't look like your usual."
 *
 * The gap this fills: the validator catches missing and inconsistent values,
 * but a field mapped to the WRONG payload path produces a perfectly
 * consistent, perfectly incorrect number on every contract. The workspace's
 * own history is the only reference that can catch it.
 *
 * Deterministic and advisory. Pure code — the send path never asks a model
 * what looks odd (invariant 2) — and a flag never blocks a send: deviating
 * from your usual is often exactly right, so this informs the human already
 * looking at the panel and stops there.
 */

export interface DeviationFlag {
  fieldKey: string;
  /** Why it stands out, in the business's own numbers. */
  kind: "amount" | "different";
  /** The established value, for display ("$150.00"). */
  usualValue: SerializedValue;
  /** How many past contracts used it. */
  usualCount: number;
  /** Robust deviations from the median — amount flags only. */
  deviations?: number;
}

const numeric = (v: SerializedValue | undefined): Decimal | null => {
  if (!v) return null;
  if (v.kind === "number") return new Decimal(v.value);
  if (v.kind === "money") return new Decimal(v.amount);
  return null;
};

const median = (xs: Decimal[]): Decimal => {
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : s[mid - 1]!.plus(s[mid]!).div(2);
};

const MAD_SCALE = new Decimal("1.4826");
/**
 * Deliberately looser than the batch outlier threshold (5): a single contract
 * has no peers to compare against, only its own past, and business values
 * drift legitimately. This flags the "wrong field entirely" magnitude —
 * budget where a retainer belongs — not "charged this client a bit more".
 */
const AMOUNT_THRESHOLD = 6;
/** Below this, a "usual" is an accident, not a pattern. */
const MIN_HISTORY = 5;
/** Non-numeric: the established value must dominate before its absence means anything. */
const DOMINANCE = 0.8;

/**
 * Flag a single field's value against that field's history.
 *
 * `history` is what this workspace actually used on past contracts (the same
 * observations `usualValue` reads). Returns null when there's nothing
 * confident to say — no history, too little of it, or the value fits.
 */
export function detectDeviation(
  fieldKey: string,
  value: SerializedValue,
  history: UsualObservation[],
): DeviationFlag | null {
  if (history.length < MIN_HISTORY) return null;

  const x = numeric(value);
  const past = history.map((h) => numeric(h.value)).filter((n): n is Decimal => n !== null);

  // Numeric: robust distance from the median.
  if (x && past.length >= MIN_HISTORY) {
    const med = median(past);
    const mad = median(past.map((p) => p.minus(med).abs()));
    const spread = mad.isZero() ? new Decimal(0) : mad.times(MAD_SCALE);
    const distance = x.minus(med).abs();

    // Every past contract used the same amount: any different amount is worth
    // a look, but only when it's materially different (a rounding-level
    // difference on a settled number is noise).
    if (spread.isZero()) {
      if (distance.isZero()) return null;
      const relative = med.isZero() ? new Decimal(1) : distance.div(med.abs());
      if (relative.lessThan("0.05")) return null;
      return {
        fieldKey,
        kind: "amount",
        usualValue: history[0]!.value,
        usualCount: past.length,
      };
    }

    const deviations = distance.div(spread);
    if (deviations.greaterThanOrEqualTo(AMOUNT_THRESHOLD))
      return {
        fieldKey,
        kind: "amount",
        usualValue: toSerialized(med, value),
        usualCount: past.length,
        deviations: Math.round(deviations.toNumber() * 10) / 10,
      };
    return null;
  }

  // Non-numeric: a strongly-established value being replaced.
  const counts = new Map<string, { value: SerializedValue; count: number }>();
  for (const h of history) {
    const key = JSON.stringify(h.value);
    const g = counts.get(key);
    if (g) g.count++;
    else counts.set(key, { value: h.value, count: 1 });
  }
  let dominant: { value: SerializedValue; count: number } | null = null;
  for (const g of counts.values()) if (!dominant || g.count > dominant.count) dominant = g;
  if (!dominant) return null;
  if (dominant.count / history.length < DOMINANCE) return null;
  if (JSON.stringify(dominant.value) === JSON.stringify(value)) return null;

  return {
    fieldKey,
    kind: "different",
    usualValue: dominant.value,
    usualCount: dominant.count,
  };
}

/** Rebuild a serialized value of the SAME shape as what's being compared. */
function toSerialized(n: Decimal, like: SerializedValue): SerializedValue {
  if (like.kind === "money")
    return { kind: "money", amount: n.toFixed(2), currency: like.currency };
  return { kind: "number", value: n.toString() };
}

/**
 * Flag a whole contract's worth of values. `histories` is keyed by field;
 * fields with no entry are skipped.
 */
export function detectDeviations(
  values: Record<string, SerializedValue>,
  histories: Record<string, UsualObservation[]>,
): DeviationFlag[] {
  const flags: DeviationFlag[] = [];
  for (const [key, value] of Object.entries(values)) {
    const history = histories[key];
    if (!history) continue;
    const flag = detectDeviation(key, value, history);
    if (flag) flags.push(flag);
  }
  return flags;
}
