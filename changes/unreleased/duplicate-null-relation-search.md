---
title: Saving a hierarchical autocomplete on a duplicated record no longer fails with "cannot delete path in scalar".
type: fixed
audience: user
date: 2026-11-09
breaking: false
---
A record created by duplication could be stored with an invalid empty search index. Any later save of a
hierarchical autocomplete on that record — by hand or through *Propagate component data* — then failed on
that record with "cannot delete path in scalar". New records are now stored correctly. A record already
affected is repaired by setting its `relation_search` column to SQL NULL wherever `jsonb_typeof(relation_search) = 'null'`.
