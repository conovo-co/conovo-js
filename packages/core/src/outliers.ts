import Decimal from "decimal.js";
import type { SerializedValue } from "./values.js";

/**
 * Batch-level outlier detection (SPEC §3.5: "39 fees are $2–5k, one is
 * $200k"). Deterministic statistics — median + MAD (median absolute
 * deviation), which one wild value can't drag around the way a mean/stddev
 * can. Pure code: the send path never asks a model what looks odd
 * (invariant 2); this feeds the pre-flight summary, a human decides.
 */

export interface OutlierFlag {
  fieldKey: string;
  /** Index into the batch's item list. */
  itemIndex: number;
  value: string;
  median: string;
  /** How many robust deviations from the median (≥ threshold). */
  deviations: number;
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

/** MAD ≈ σ via the 1.4826 consistency constant for normal data. */
const MAD_SCALE = new Decimal("1.4826");
const DEFAULT_THRESHOLD = 5;
const MIN_ITEMS = 4;

/**
 * values[fieldKey][itemIndex] — one column per money/number field across the
 * batch (undefined where an item didn't resolve that field). Fields with
 * fewer than MIN_ITEMS resolved values are skipped: no distribution, no
 * judgment. A zero MAD (everyone identical) flags any differing value.
 */
export function detectOutliers(
  values: Record<string, (SerializedValue | undefined)[]>,
  opts: { threshold?: number } = {},
): OutlierFlag[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const flags: OutlierFlag[] = [];

  for (const [fieldKey, column] of Object.entries(values)) {
    const present: { index: number; x: Decimal }[] = [];
    for (let i = 0; i < column.length; i++) {
      const x = numeric(column[i]);
      if (x) present.push({ index: i, x });
    }
    if (present.length < MIN_ITEMS) continue;

    const xs = present.map((p) => p.x);
    const med = median(xs);
    const mad = median(xs.map((x) => x.minus(med).abs())).times(MAD_SCALE);

    for (const { index, x } of present) {
      const dev = x.minus(med).abs();
      if (mad.isZero()) {
        if (!dev.isZero())
          flags.push({
            fieldKey,
            itemIndex: index,
            value: x.toString(),
            median: med.toString(),
            deviations: Number.POSITIVE_INFINITY,
          });
        continue;
      }
      const k = dev.div(mad);
      if (k.gte(threshold))
        flags.push({
          fieldKey,
          itemIndex: index,
          value: x.toString(),
          median: med.toString(),
          deviations: Number(k.toFixed(1)),
        });
    }
  }
  return flags;
}
