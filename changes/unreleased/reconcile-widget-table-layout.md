---
title: The Reconcile panel's table is readable: each reconcile's name sits above its description, headers read as headers, and Check / Apply stay on one line.
type: fixed
audience: admin
date: 2026-10-26
---
Maintenance → PostgreSQL → Reconcile listed every registered reconcile in a table whose first column squeezed the name into a few letters per line while the description ran beside it, and whose buttons wrapped their labels to `Che ck` / `App ly`. The name now reads as a heading with its description underneath, the header row is styled as a header, and the two buttons keep their width. A run whose last check found drift is marked on its **Last run** cell, which previously carried the mark on an element that painted nothing.
