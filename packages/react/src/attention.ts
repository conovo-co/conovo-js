import type { FieldSource, FieldType } from "@conovo/core";
import { tryParseInput } from "./values.js";

/**
 * The review screen's "needs your attention" list (SPEC §3.1.4 — the wizard
 * should drive the user to push the auto-fill score up, not leave them to find
 * the soft spots themselves).
 *
 * A long contract produces a long field list, and the items that actually want
 * a human — a low-confidence guess, a standing term with no value, a formula
 * that never got written — look exactly like the ones that don't. This
 * collects them so the pane can offer a jump list instead.
 *
 * Pure so it can be unit-tested; the component only renders what comes back.
 */
export interface AttentionItem {
  /** `data-card` of the card to scroll to. */
  cardKey: string;
  label: string;
  /** Plain-English consequence of leaving it as-is. */
  reason: string;
  /**
   * `fix` — saving now bakes in something wrong or incomplete.
   * `check` — a call we couldn't make for them; either answer is valid.
   */
  tone: "fix" | "check";
}

/** Structural shapes — the studio's Editable* types satisfy these. */
interface FieldLike {
  accepted: boolean;
  key: string;
  label: string;
  type: FieldType;
  source: FieldSource;
  confidence: number;
  expression?: string | undefined;
  defaultRaw?: string | undefined;
  hasSavedDefault?: boolean | undefined;
  binding?: { path: string; accepted: boolean } | undefined;
}

interface SectionLike {
  accepted: boolean;
  key: string;
  label: string;
  expression: string;
}

/** `data-card` of the unmapped-blanks block, which isn't a card of its own. */
export const BLANKS_CARD = "__blanks";

export function collectAttention({
  fields,
  sections,
  blankCount,
}: {
  fields: FieldLike[];
  sections: SectionLike[];
  blankCount: number;
}): AttentionItem[] {
  const fix: AttentionItem[] = [];
  const check: AttentionItem[] = [];

  for (const f of fields) {
    // An unchecked field isn't part of the template, so nothing about it can
    // be wrong. Flagging it anyway reads as an unfixable error against
    // something the user already decided to leave out — the confidence badge
    // on the card is where "we weren't sure" belongs.
    if (!f.accepted) continue;

    if (f.source === "workspace_default" || f.source === "per_deal") {
      const raw = f.defaultRaw?.trim() ?? "";
      const parsed = raw ? tryParseInput(f.type, raw) : null;
      if (parsed && "error" in parsed) {
        fix.push({
          cardKey: f.key,
          label: f.label,
          reason: parsed.error,
          tone: "fix",
        });
      } else if (!raw && !f.hasSavedDefault && f.source === "workspace_default") {
        // Only standing terms nag when empty. A per-deal default is an OFFER
        // ("stop asking me"), and empty is its normal state.
        fix.push({
          cardKey: f.key,
          label: f.label,
          reason: "no standing value yet — you'll be asked for it every time",
          tone: "fix",
        });
      }
    }

    if (f.source === "computed" && !f.expression?.trim()) {
      fix.push({
        cardKey: f.key,
        label: f.label,
        reason: "set to calculate but has no formula — it won't fill",
        tone: "fix",
      });
    }

    // A binding we proposed but didn't auto-accept is free auto-fill sitting
    // one click away, which is exactly what the score is asking them to raise.
    if (f.binding && !f.binding.accepted) {
      check.push({
        cardKey: f.key,
        label: f.label,
        reason: `could fill from your data (${f.binding.path}) — confirm or ignore`,
        tone: "check",
      });
    }
  }

  // A field's name is the only thing the sender sees when filling it in, so two
  // fields called the same thing are indistinguishable exactly where it matters.
  // Blank-derived fields collide constantly — a document repeating one fill-in
  // marker ("DATES / weeks" five times) yields five fields all named that — and
  // nothing downstream can recover a name the template never had.
  //
  // One entry per collision rather than per field: five rows reading the same
  // unreadable label would bury every other item in a list that only shows five,
  // and renaming one shrinks the group, so the next press walks to what's left.
  const byLabel = new Map<string, FieldLike[]>();
  for (const f of fields) {
    if (!f.accepted) continue;
    const name = f.label.trim().toLowerCase();
    const group = byLabel.get(name);
    if (group) group.push(f);
    else byLabel.set(name, [f]);
  }
  for (const group of byLabel.values()) {
    const first = group[0];
    if (!first || group.length < 2) continue;
    fix.push({
      cardKey: first.key,
      label: first.label,
      reason: `${group.length} fields share this name — you won't know which is which when filling one in`,
      tone: "fix",
    });
  }

  // Parties and groups aren't considered at all: an unchecked one is a
  // decision, and an accepted one carries no value that can be malformed.

  for (const s of sections) {
    if (!s.accepted) {
      // Sections always start unaccepted (invariant 1), so every one is an
      // open decision — and dropping paragraphs is the biggest call here.
      check.push({
        cardKey: s.key,
        label: s.label,
        reason: "keep these paragraphs always, or only under a condition",
        tone: "check",
      });
    } else if (!s.expression.trim()) {
      fix.push({
        cardKey: s.key,
        label: s.label,
        reason: "no condition set — these paragraphs will always stay in",
        tone: "fix",
      });
    }
  }

  if (blankCount > 0) {
    fix.push({
      cardKey: BLANKS_CARD,
      label: blankCount === 1 ? "1 unmapped blank" : `${blankCount} unmapped blanks`,
      reason: "fill-in markers no field covers — they print exactly as written",
      tone: "fix",
    });
  }

  // Things that will be wrong come before things that are merely undecided.
  return [...fix, ...check];
}

/**
 * The card the "Fix next one" bar should jump to.
 *
 * Walks the list in its own order — everything that will be wrong before
 * everything merely undecided — starting after whichever card we sent them to
 * last, so repeated presses move forward instead of re-selecting the top item.
 *
 * Two properties fall out of reading `current` by VALUE rather than by index:
 * a card that has since been fixed is no longer in the list, so we restart from
 * the top rather than resuming a position that now means something else; and
 * the walk wraps, because dead-ending on the final item leaves someone pressing
 * a button that does nothing.
 *
 * Pure so it can be unit-tested; the component only scrolls to what comes back.
 */
export function nextAttentionCard(
  items: AttentionItem[],
  current: string | null,
): string | null {
  if (items.length === 0) return null;
  const from = current ? items.findIndex((a) => a.cardKey === current) : -1;
  // Distinct cardKey: several reasons can name one card, and stepping through
  // the same card twice reads as the button being broken.
  for (let i = 1; i <= items.length; i++) {
    const candidate = items[(from + i) % items.length];
    if (candidate && candidate.cardKey !== current) return candidate.cardKey;
  }
  return items[0]?.cardKey ?? null;
}
