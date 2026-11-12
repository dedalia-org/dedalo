---
title: Searching or sorting through a link to external records no longer fails or matches the wrong record.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-search-hop-join-record-address
---
A portal can link records of an external service whose identifiers are kept exactly as the
service writes them — a zero-padded catalogue number such as `001338683`, or an identifier
with letters such as `Q42`. A search through such a field ("does not contain", "is empty", or
any search over the linked record's fields) and a sort by a linked field used to fail with an
error when an identifier contained letters, and to read an unrelated local record when it was
zero-padded. Now such a link reaches no local record: "does not contain" and "is empty" count
the record as having nothing linked there, and a sort places it with the empty values.
