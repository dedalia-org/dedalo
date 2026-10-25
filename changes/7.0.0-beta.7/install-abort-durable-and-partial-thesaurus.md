---
title: Installer and container fixes — `--abort` removals survive a power cut, a half-imported thesaurus is no longer reported installed, the published client never points at a missing copy
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-hierarchy-import-partial-refused
---
- **`--abort` survives a power cut.** When the installer takes back what it wrote — the
  `.env` it created, its backups and staged copies of the secrets, and its own run record —
  the removals are now forced to disk before it reports *aborted*. Before, a power cut right
  after could bring those files back: the database password on disk again, or a run record
  that `--resume` took for a live install.
- **A thesaurus whose models never landed is no longer "already installed".** When the terms
  of a thesaurus are in the database but a section its release ships data for (typically the
  models) is empty, installing it again used to answer *already installed — skipped*, and
  the missing section never arrived. It is now refused with a line naming the empty section
  and *Reset to seed* (*Maintenance → Install hierarchies*), which imports the whole
  thesaurus; nothing is written by the refusal.
- **Container stacks: the client copy is replaced without a gap.** When the engine
  republishes a damaged copy of the client at start-up, the new copy now gets its own
  directory and the web server is switched to it in one step. Before, there was a short
  window — and, after a power cut there, a lasting one until the next start — in which the
  web server pointed at a copy that was not there.
- **The installer's ontology step says what it checked.** Downloaded ontology files are
  checked for their format, over a verified connection to the configured ontology server;
  the master server does not publish digests to check them against. The step now reports
  them as *shape-checked*, not *verified*.
