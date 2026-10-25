---
title: The installer no longer crashes when a check's helper process stops before reading its request.
type: fixed
audience: admin
date: 2026-10-23
---
Each installer check (System, database, mail, …) runs in a helper process of its own. If that
process stopped before reading what it was asked to check — failing at start, or stopped at its
time limit — the installer itself could exit with a "broken pipe" error. The check now simply
fails, with a sentence saying the helper did not read its request, and the installer stays open.
