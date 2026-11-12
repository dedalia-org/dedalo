---
title: A duplicated record's image opens in the edit view again, with its drawing layers.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-duplicate-image-svg-envelope
---
Before, duplicating a record copied its image files but the copy's image field showed only the
empty placeholder in the edit view, and a later save of the copy's drawing could show the
original record's picture. The copy's drawing editor also loaded the original record's
picture as its background.

Now the copy gets its own image wrapper: every drawing layer of the original is kept, and it
points at the copy's own picture, in the image field and in the drawing editor. If the original's drawing cannot be copied (it is not a
valid drawing), the duplicate still succeeds and the problem is logged.

**Action needed:** records duplicated before this fix: run **Update cache** (regenerate) on
them to get the image back in the edit view.
