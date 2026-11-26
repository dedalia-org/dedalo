---
title: A search through a linked record no longer matches links held in fields you cannot see in that record's section.
type: security
audience: user
date: 2026-11-12
wc: WC-2026-09-30-search-root-step-acl, WC-2026-10-01-search-hop-configured-targets
---
A search that filters by "linked to this record" through another field (for example, hosts whose
portal reaches a record that itself links to a given term) checked your permission on the
linking field only in the section the search named. When the portal reaches two sections that
share a table — a section and its virtual twin — links stored in the twin were matched even if
your profile hides that field there.

Now the field is checked in every section the search actually reaches: links in a section where
the field is hidden from you are not matched, and the answer carries the usual "out of your
scope" notice. Administrators and searches that see every field answer as before.
