---
title: Dark mode: the page canvas no longer sits above the cards, and empty-field hints are legible
type: fixed
audience: user
date: 2026-10-18
---

In **dark mode**, the page background was painted with the light theme's canvas
grey. Because the dark palette inverts the grey ramp, that grey became *lighter*
than every content surface: cards, the list body and the login card sank into a
lighter field, and the search band around the filters merged with it. The canvas
is now the role token meant for it, which is darker than every surface in dark
mode and the same colour as before in light mode — the light theme renders
byte-for-byte identically.

Empty-field hints — a portal or dataframe's empty value (*Etiqueta*, *Título*,
*http://*, the date *DD/MM/YYYY* masking), and the browser's own placeholder in
every other input — were below the WCAG AA floor: 1.9:1 in light and 2.7:1 in
dark for the portal hint, 3.1–3.9:1 for the rest, because the browser paints a
placeholder with its own light-scheme grey and the app never themed it. Hints now
carry the muted-text token in both themes: 8.1:1 on the dark card and 5.7:1 on
the light one.

The edit view's field placeholders were also dimmed by an extra 30% opacity that
took them under AA; they now render at their label ink's own contrast.
