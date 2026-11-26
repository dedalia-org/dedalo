---
title: Calculated fields: a formula definition must name the TypeScript engine and a `.ts` formula file; the earlier engine's definitions are refused
type: changed
audience: admin
date: 2026-11-13
breaking: true
wc: WC-2026-11-13-calculation-tld-packages
---
A `calculation` widget's `process` block now selects its formula by **file and
name**: `{ "fn": "…", "file": "/calculation/formulas.ts", "engine": "ts" }` for
the generic formulas, `"file": "/<tld>/calculation/<module>.ts"` for the
formulas that belong to one ontology (the mdcat grant chain: periods, grant
amounts, euro conversion, final totals). The file is a lookup key — the engine
never loads code from it. A definition in the earlier engine's shape (a formula
file that is not a `.ts` name, an engine other than `"ts"`, or no engine) is
**refused**: the field reports an
error naming the block instead of computing, and nothing is substituted. The
vendored ontology packages still carry the earlier shape, so an installation
that uses calculated fields needs the updated master ontology (an ontology
update, no data change). The two grant-amount cases that reported an error
pending a decision are decided: a grant amount with **no days** (no day value,
or days adding up to zero) shows **no value**, not a minimum; the **major-grant
amount** applies to the grant section the earlier engine treated specially,
and to no other.
