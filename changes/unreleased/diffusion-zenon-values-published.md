---
title: Published bibliography columns that read from Zenon now carry their values.
type: fixed
audience: admin
date: 2026-11-13
wc: WC-2026-11-12-diffusion-external-chain
---
A publication column whose source reaches a Zenon field (for example the bibliography
columns of a publication: authors, title, date) was published **empty** on every record —
the values shown on screen never reached the public database or files. They are now
published, in the language set for the publication (its main language, else the
installation's default data language), whoever starts the run.

When Zenon cannot be read during a run (the service is down, blocked or not configured),
the record is still published with its other values, and the run report lists one line
per missing value naming the field and the Zenon record.

**Action needed:** republish the sections whose publication includes Zenon fields, so the
public tables receive the values. Nothing in the catalogue itself needs repairing.
