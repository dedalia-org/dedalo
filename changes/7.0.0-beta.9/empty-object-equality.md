---
title: Fields whose value holds an empty object no longer look edited when they are not.
type: fixed
audience: user
date: 2026-11-09
---
The client's value comparison treated two empty objects as different, so a value containing one
(for example a map point, whose stored shape carries empty properties) never matched its saved
copy. Such fields always sent a save that changed nothing, and setting them back to the saved
value left the orange unsaved line and the leave-page warning on. Both now behave like every
other field.
