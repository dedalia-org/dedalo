---
title: Users who are allowed to see a section's change history can open *Latest changes* and *Component history* again.
type: fixed
audience: user
date: 2026-10-22
wc: WC-2026-10-22-tm-scope-whole-request
---
A user who is not an administrator but whose profile grants a section's history list got a
permission error in the inspector's *Latest changes* and *Component history*. The history now opens for every user the profile allows, also when the
history list sits inside a group of the section. Users without that permission no longer see the
two blocks at all, and a block that cannot load shows one short line inside the block instead of a
full-page error. The record counter of a history list follows the same permission.
The history follows the same rule as the Time Machine tool: a user allowed to see a section's
history sees the changes of every record of that section, also of records outside their projects
and of deleted records.
A history list shows only the section it was opened for, for every user: a search of another
section remembered in the session no longer replaces it after a reload. An administrator's own
Time Machine list, opened with no section, keeps its saved search across a reload.
The history never shows the past values of a field the user's profile does not let them read on
the record: those cells stay empty, the rest of the change (who, when, which field) is shown.
