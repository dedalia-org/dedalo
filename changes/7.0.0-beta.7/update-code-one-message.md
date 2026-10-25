---
title: A code update that is refused says so once, not three times
type: fixed
audience: admin
date: 2026-10-20
---

When an update could not start — no maintenance mode, no recent backup, a bad checksum — the **Update code** panel printed the same refusal in three places at once: a generic "Process 2" line, a red banner that floated over the list of update steps, and the panel's own notice underneath. The steps list also stayed on screen with every phase marked "Pending", which read as an update that was stuck rather than one that never started.

Now the panel states the refusal in one place, in the interface language, and nothing floats over the panel. The progress list is kept only when something actually ran; a run that fails part-way still shows which step failed, once.
