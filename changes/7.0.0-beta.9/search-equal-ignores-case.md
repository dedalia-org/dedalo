---
title: The `=` exact-match search now ignores letter case, so `=vic` finds "Vic".
type: fixed
audience: user
date: 2026-11-11
---
Typing `=` before a word searches for values that are exactly that word. It already ignored
accents but, by mistake, not capital letters: `=vic` did not find "Vic" — only `=Vic` did.
Now both work, and `!=vic` ("not exactly vic") excludes "Vic" too. The double `==` and the
quoted `'Vic'` forms still match capital letters exactly, because the import tools use them to
find a precise existing record. On a database created with the plain `C` locale, only Latin
letters are matched regardless of case; Cyrillic or Greek capitals still have to be typed.
