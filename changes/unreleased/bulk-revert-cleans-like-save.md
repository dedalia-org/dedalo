---
title: Reverting a batch run cleans the values it puts back like a normal save
type: fixed
audience: user
date: 2026-11-18
wc: WC-2026-11-17-tm-restore-value-gates
---

**Revert the bulk process** put each value back exactly as the run had found it. A value from before the engine cleaned that kind of value came back uncleaned: a rich text could return with scripts or event handlers, and a number in a format its field no longer uses. The same was true of a record the revert restored whole — one a run had emptied or deleted.

Now every value a revert puts back passes the same checks as a normal save, like a single restore from the Time Machine. Rich text is cleaned, a number is formatted as its field declares, and a password entry stored as plain text is never written back: that field (or that record) is left as it is and listed as skipped (*failed*), while the rest of the run is still reverted. A password entry from a Dédalo v6 installation is put back as recorded. A deleted record the revert would bring back is checked against your projects before its values are: one outside them is listed as *out of scope* whatever its history holds, and one inside them whose values cannot be stored is listed as *failed* at that record. For developers reading the response: a *failed* entry carries the error code of what stopped it once your access to that record has been checked; an entry the report does not locate carries no record number, and no code either when it failed before that check. A value that was already clean is restored exactly as before, and the other languages of a translated field are not touched.

Reverting the same run again finds those fields *already at the pre-run value* — a value the first revert cleaned is not reported as edited since.
