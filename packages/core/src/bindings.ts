import { z } from "zod/v4";

/** Binding proposal: a field key → JSON path into the platform's payload. */
export const bindingProposalSchema = z.object({
  fieldKey: z.string(),
  /** Dot path into the registered sample payload, e.g. "customer.name". */
  path: z.string(),
  confidence: z.number(),
  rationale: z.string(),
});
export type BindingProposal = z.infer<typeof bindingProposalSchema>;

export const bindingResultSchema = z.object({
  bindings: z.array(bindingProposalSchema),
});
export type BindingResult = z.infer<typeof bindingResultSchema>;

/** Flatten a sample payload into dot paths with example values. */
export function flattenPayload(
  value: unknown,
  prefix = "",
): Array<{ path: string; example: string }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [{ path: prefix, example: JSON.stringify(value) }] : [];
  }
  const out: Array<{ path: string; example: string }> = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenPayload(v, path));
    } else {
      out.push({ path, example: JSON.stringify(v) });
    }
  }
  return out;
}

/**
 * Segments that address JavaScript's object machinery rather than payload
 * data. Writing through `__proto__` reaches Object.prototype and changes
 * every object in the process — `applyPayloadAdditions` did exactly that
 * before this list existed, from a path the MODEL proposes. Reading through
 * them is no more legitimate: a payload's `constructor` is never a customer
 * field, so a binding path that names one is a bug or an attack either way.
 */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Deep clone of a plain JSON value.
 *
 * Deliberately not `structuredClone`: that global is declared only in lib.dom
 * or @types/node, and this package declares neither on purpose — core runs in
 * the browser through @conovo/react and on the server through
 * @conovo/node, so reaching for either lib would let environment-specific
 * APIs into a package that has to work in both. The value here is a registered
 * payload sample, which is JSON by construction, so a plain recursive clone is
 * the whole requirement.
 */
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = clonePlain(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Apply proposed additions to a sample payload, in pure code.
 *
 * The MODEL proposes paths; this builds the patched sample. Keeping the merge
 * here rather than asking for a rewritten payload means a model can never
 * mangle, drop, or silently retype what the platform already registered — the
 * worst it can do is propose an addition that gets rejected below.
 *
 * Rejects (never throws — a bad proposal is data, not an exception):
 * - a path that already resolves (it isn't a gap)
 * - a path that would traverse or overwrite a non-object leaf
 * - a path that addresses the prototype chain rather than payload data
 * - empty/blank segments
 *
 * Returns the patched clone plus the applied and rejected paths, so callers can
 * show the engineer exactly what was and wasn't taken.
 */
export function applyPayloadAdditions(
  sample: unknown,
  additions: Array<{ path: string; value: unknown }>,
): { patched: unknown; applied: string[]; rejected: Array<{ path: string; reason: string }> } {
  const patched: Record<string, unknown> =
    sample !== null && typeof sample === "object" && !Array.isArray(sample)
      ? (clonePlain(sample) as Record<string, unknown>)
      : {};
  const applied: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  for (const addition of additions) {
    const segments = addition.path.split(".");
    if (segments.some((s) => s.trim() === "")) {
      rejected.push({ path: addition.path, reason: "empty path segment" });
      continue;
    }
    const unsafe = segments.find((s) => UNSAFE_SEGMENTS.has(s));
    if (unsafe) {
      rejected.push({
        path: addition.path,
        reason: `"${unsafe}" isn't a payload field`,
      });
      continue;
    }
    if (resolvePath(patched, addition.path) !== undefined) {
      rejected.push({ path: addition.path, reason: "already in the payload" });
      continue;
    }

    // Walk to the parent, creating plain objects as needed. Bail if any step
    // would tunnel through an existing scalar or array.
    let cursor: Record<string, unknown> = patched;
    let blocked: string | null = null;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (next === undefined) {
        const created: Record<string, unknown> = {};
        cursor[segment] = created;
        cursor = created;
      } else if (next !== null && typeof next === "object" && !Array.isArray(next)) {
        cursor = next as Record<string, unknown>;
      } else {
        blocked = `"${segment}" is already a value, not an object`;
        break;
      }
    }
    if (blocked) {
      rejected.push({ path: addition.path, reason: blocked });
      continue;
    }

    cursor[segments[segments.length - 1]!] = addition.value;
    applied.push(addition.path);
  }

  return { patched, applied, rejected };
}

/**
 * Resolve a dot path against a payload; undefined when absent. A path that
 * reaches for the prototype chain resolves to nothing rather than handing
 * back a function or a shared object — at send time this is a confirmed
 * `bindingPath`, and the honest answer for one is "the payload has no such
 * field", which the resolver already knows how to report as a payload miss.
 */
export function resolvePath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (UNSAFE_SEGMENTS.has(seg)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
