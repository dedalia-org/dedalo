---
title: The installer's --plain mode refuses answer flags before it asks any question, and names the flags it refused.
type: fixed
audience: admin
date: 2026-10-26
---
Before: combining `--plain` (the interactive front end) with an answer flag such as `--answers`, `--plan`, `--execute` or `--root-password` failed with one generic sentence, and only after some questions had been asked.
Now: the combination is refused at the start, before any prompt, and the refusal names each flag that caused it. Give those answers on the interactive screens instead.
