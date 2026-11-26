---
title: A refreshed portal shows its values normally, with their separators.
type: fixed
audience: user
wc: WC-2026-11-10-portal-get-data-children-lang
date: 2026-11-10
---
After a portal refreshed without a page reload (for example after editing a row in its own window, or changing page), a translatable column showed its values as if they were missing in the current language (highlighted) and with no comma between multiple values. The refresh now reads those columns in the current data language, exactly as a page load does, so the cell looks the same either way.
