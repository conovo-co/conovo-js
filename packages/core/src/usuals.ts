import type { SerializedValue } from "./values.js";

/**
 * "You've used $95.00 on 6 contracts" — the business's own history as a
 * suggestion.
 *
 * Deliberately deterministic: the number offered to fill a legal document
 * comes from values THIS workspace chose on real contracts (provenance
 * per_deal or edited — the human-typed channels), never from a model's idea
 * of what businesses usually charge. Pure so it can be unit-tested; the API
 * queries history and this picks the candidate.
 */

export interface UsualObservation {
  value: SerializedValue;
  /** When the contract using it was created — ISO string or epoch ms. */
  at: string | number;
}

export interface UsualValue {
  value: SerializedValue;
  /** How many contracts used exactly this value. */
  count: number;
}

/**
 * The value used most often; ties go to the most recently used. Null when
 * there is no history — one past use is still worth offering (the copy shows
 * the count, so "used on 1 contract" reads as exactly as weak as it is).
 */
export function usualValue(history: UsualObservation[]): UsualValue | null {
  const groups = new Map<string, { value: SerializedValue; count: number; latest: number }>();
  for (const o of history) {
    const key = JSON.stringify(o.value);
    const at = typeof o.at === "number" ? o.at : Date.parse(o.at);
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.latest = Math.max(g.latest, at || 0);
    } else {
      groups.set(key, { value: o.value, count: 1, latest: at || 0 });
    }
  }
  let best: { value: SerializedValue; count: number; latest: number } | null = null;
  for (const g of groups.values()) {
    if (!best || g.count > best.count || (g.count === best.count && g.latest > best.latest))
      best = g;
  }
  return best ? { value: best.value, count: best.count } : null;
}
