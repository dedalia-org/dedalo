---
title: `bun run test:crawl` checks every feature as an administrator and as a project-scoped editor.
type: added
audience: developer
date: 2026-10-27
---
Checking Dédalo by hand as an administrator and again as an editor took days. A new
browser check does it on the test database: three users — the superuser, an
administrator who is not the superuser, and an editor limited to one project — each open
everything their own menu offers. For every section it opens the list and a record, checks
one field of each kind at the permission level the server grants, opens every inspector
panel and every tool offered, and fails on any script error, refused request or error panel.

It then tries what a user must NOT be able to do, by typing the address directly: a section
without permission, a record of another project, a tool not granted. Each must be refused.
Finally it replays real user actions — logging in through the form, logging out, editing
and saving, creating and deleting a record, exporting a CSV — and checks the result on the
server. An export by the editor must contain only their project's records.

Run it with `bun run test:crawl` (`--out <dir>` keeps a report and a screenshot of every
problem). Known problems are listed with their reason in `test/helpers/feature_crawl_ratchet.ts`;
a listed problem that gets fixed must be removed from the list.
