---
title: "A record recovered from the Time Machine no longer stays in the list of deleted records, and the section's list opens again without its old search."
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-tm-recover-consumes-deleted-listing
---
The Time Machine of a section lists its deleted records, ready to be recovered. A record
recovered from it stayed in that list, so it could be recovered a second time over the edits
made since, and a record deleted twice was listed twice. Now:

- a recovered record leaves the list; its entries stay in its history, nothing is erased;
- a record deleted again is listed once, by its latest deletion;
- a record that exists is never listed, whatever history entries it carries;
- after a recovery the section's list opens without the search, filter or page you had left
  on it.

**Action needed:** none.
