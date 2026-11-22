---
title: "Activating or repairing a hierarchy links its root term only when it is unambiguous — the one term without a parent — and keeps every valid root."
type: changed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-hierarchy-root-link-rule
---
The *General term* of a hierarchy is the root its thesaurus tree hangs from. When it was
missing, or pointed at a record that does not exist, while the hierarchy's section already held
terms, **Activate / repair** (and the installer's activation) linked the term with the lowest
number — which could be any imported term, not the root. Now:

- it links the **one term that has no parent**;
- when several terms have no parent, or none has, it **changes nothing** and the *General term*
  line of the status panel says **root ambiguous** — choose the root yourself in the
  hierarchy's *General term* field, then repair again;
- a *General term* holding several roots keeps **every** root that exists; only links to
  records that no longer exist are removed, and each one removed is listed;
- a newly created root is named after the hierarchy also when the section declares several
  term fields (the first one is used), and never through a field that is not a text field.

**Action needed:** three thesauri shipped with Dédalo hold more than one term without a
parent — Spain (`es`), Cuba (`cu`) and France (`fr`). Installing one of them now ends with
*root ambiguous*: open its hierarchy record and choose its root term (for Spain, *España*).
Details: [Hierarchy tool](./using/tools/using_hierarchy.md#tips-and-gotchas).
