"use client";

import { useState } from "react";

/** Where a field sits in the contract, for "what is this even for?". */
export interface Excerpt {
  paragraphIndex: number;
  before: string;
  match: string;
  after: string;
}

/**
 * The sentence from the contract with this field's spot marked.
 *
 * Collapsed by default: it answers a question people only sometimes have, and
 * a panel of permanently-expanded excerpts is unreadable. `defaultOpen` is for
 * when it stops being a curiosity and becomes the only answer — several fields
 * sharing one label, where the label itself distinguishes nothing and a
 * collapsed disclosure just hides the one thing worth reading. Shared by the
 * send panel and the template list so both explain a field the same way.
 */
export function WhereItGoes({
  context,
  defaultOpen = false,
}: {
  context: Excerpt;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="whereitgoes">
      <button className="linkish" onClick={() => setOpen((v) => !v)}>
        {open ? "hide where this goes" : "where does this go?"}
      </button>
      {open && (
        <p className="excerpt">
          {context.before}
          <mark>{context.match}</mark>
          {context.after}
        </p>
      )}
    </div>
  );
}
