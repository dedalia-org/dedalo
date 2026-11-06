---
title: An ontology master can promote chosen tlds from another provider.
type: changed
audience: admin
date: 2026-11-06
---
An installation that serves ontology (`IS_AN_ONTOLOGY_SERVER=true`) can now list other providers in `ONTOLOGY_SERVERS` and update chosen tlds from them, with the same checks as any update: census, recovery snapshot, file digests and the data-model refusal. On such an installation only entries that list `tlds` are providers; an entry without them is code-only (it supplies an accepted access code and nothing is pulled from it), so a remote can never replace the whole authored ontology. Tlds no provider lists stay untouched. Without providers nothing changes. `bun run update plan <release>` now asks every configured code server for the release, instead of only the first.
