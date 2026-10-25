---
title: An update or a move transform that committed after a lost connection says what did not run
type: fixed
audience: admin
date: 2026-10-21
---
If the database connection fails while a data update or a *move* transform file is
being committed, Dédalo asks the database whether the work committed and reports it as
applied when it did. Some follow-up actions only run after a commit Dédalo saw
succeed, such as updating dependent fields and ending the sessions of users whose
access changed. In this case they were skipped without a word. The report now says
that they did not run and what to do: run the *observer_mirrors* reconcile (an update
starts one itself), and end the sessions of any account whose access the change
affected.
