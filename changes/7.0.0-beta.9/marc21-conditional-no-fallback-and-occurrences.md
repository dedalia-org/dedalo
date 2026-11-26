---
title: "MARC21 import: a conditional rule with no matching copy writes nothing, and a rule can join every repetition of one field (`occurrences: \"all\"`)."
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-11-12-marc21-config-map-and-transforms
---
A conditional rule (`marc21_conditional`, e.g. the 945 holdings of the copy whose `$j` is your
library's code) used to fall back to the record's **first** 945 when none of its copies
matched — so a record held only by other libraries was imported with another library's shelf
mark, volume and barcode. Now such a rule writes nothing for that record.

A rule reading one repeated field (a 700 added entry, say) still takes the first repetition
by default. Add `"occurrences": "all"` to the rule to join every repetition into one value,
separated by the rule's `row_separator` (default `". "`), without listing several tags under
`field_multiple`. Any other value of `occurrences`, or combining it with a conditional rule,
stops the import with a message naming the rule.

**Action needed:** none for the shipped map. Review a Tools configuration that relied on the
old fallback.
