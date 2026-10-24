---
title: Pasting into the search panel's Id field adds to what is already there instead of replacing it.
type: fixed
audience: user
date: 2026-10-21
---
In the search panel, pasting into a section's *Id* field replaced the whole field with the
clipboard, so ids you had already typed were lost, and a single pasted line went in
unfiltered, letters included.

A paste now goes where the cursor is, or replaces only the selected text, like a paste
anywhere else. A single line keeps only the characters the field accepts (digits and the
search operators `.` `,` `>` `<` `=`). A list pasted from a spreadsheet column, one id per
line, still becomes a comma-separated list, and a comma is added between it and the ids
already on either side.
