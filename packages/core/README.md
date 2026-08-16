# @conovo/core

Pure, deterministic core for [Conovo](https://conovo.co): the field
taxonomy, the decimal-safe expression engine, the resolver (payload →
defaults → preset → computed → per-deal), and the validation gate.

You normally don't install this directly — `@conovo/react` and the
Conovo API use it under the hood. It exists as its own package because the
send path must be reproducible forever: no AI, no network, no floating-point
money math, ever.
