---
title: An open-ended Id range means what it says — `5...` is every id from 5 up, `...5` every id up to 5, and `...` alone is an empty input.
type: changed
audience: user
date: 2026-11-13
wc: WC-2026-11-12-section-id-open-between
---
The meaning of the missing side of an Id range is settled. `100...` finds every
record with id 100 or more and `...200` every record with id 200 or less (negative
ids included); `...` with no number adds no condition, like an empty field. Earlier
versions read `5...` as "exactly 5" — a saved search using that form now returns the
whole open range.
