---
title: The assistant's find-or-create no longer duplicates a record under concurrent calls
type: fixed
audience: user
date: 2026-10-21
breaking: false
---
When two assistant requests asked for the same record at the same moment (find it by its fields, or create it), both could miss it and both create it, leaving two records with the same identity. The search is now asked again under a lock before anything is created, so the second request finds the record the first one created.
