---
title: Paging to the last records of a large section is fast for users limited to their projects.
type: fixed
audience: user
date: 2026-10-25
---
A user who is not an administrator, and who sees a section through their projects, waited
around half a second or more for every page near the end of a large section (for example
stepping through records in edit mode from the newest one). Administrators were already
fast there. Those pages are now read from the nearer end of the list, as they already
were for administrators, so the last records open in milliseconds. Pages in the middle of
a very large section are no slower than before. The records and their order are unchanged.
