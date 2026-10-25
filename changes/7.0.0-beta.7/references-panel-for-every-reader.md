---
title: The References panel and its graph open for every user who can read the record, and their page counts add up
type: fixed
audience: user
date: 2026-10-22
breaking: false
wc: WC-2026-10-22-related-search-one-scope
---
A user who was not the superuser got *Insufficient permissions* when opening a
record's References panel or its relations graph, even with read access to the
record. They now open for anyone who can read the record, listing only the
referring records that user may see. The total shown by the panel's paginator
now matches its pages: before, a user who could not see some referring records
got short pages and could never reach the total, and counting those records grew
slower with every record the user could not see. See
[relation_list](./core/ontology/relation_list.md).
