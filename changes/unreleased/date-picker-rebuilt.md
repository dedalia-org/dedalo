---
title: The date field's calendar now writes the dates the catalogue actually stores — including year-only, year+month and BCE (negative) years — with localized month names and full keyboard and touch support.
type: changed
audience: user
date: 2026-10-15
breaking: false
---
Before: clicking the calendar opened a third-party picker that only understood complete CE dates in a four-digit year (it also showed English month names regardless of the interface language). Opening it on a year-only, year+month or BCE value fell back to *today*, and picking a day there replaced the value with a full modern date.

Now: the calendar is built into the component and speaks the same date model the catalogue stores. The year field accepts any signed year (with a CE/BCE toggle and decade steps), the month and weekday names follow the interface language, and the footer commits the precision you need — the bare year (`-205`), the year and month (`04/2022`) or a full day. The picker is fully keyboard driven (arrows, PageUp/PageDown, Home/End, Escape; the calendar button is a tab stop, and Alt+ArrowDown opens it from the field; pressing the calendar button again closes the open calendar instead of reopening it), its touch targets grow on phones and tablets, and it follows the light and dark themes. In the search panel the calendar button appears on the field's top-left corner when the field takes focus, a range's two dates share the row in full and its `<>` hangs under the gap between them, so the card keeps the same height as every other search field. The separate clock picker now uses the operating system's own time wheels on touch devices, and its button closes it on a second press too.

