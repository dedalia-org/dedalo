---
title: Emptying a record's data no longer moves it out of your project.
type: fixed
audience: user
date: 2026-11-10
wc: WC-2026-11-10-wipe-filter-user-default
---
Deleting a record's **data** (keeping the record) empties every field except its
projects, which are reset. They used to be reset to the installation's default
project, whoever did it — so a cataloguer working in their own project lost sight
of the record they had just emptied: they could no longer find, open, edit or
restore it. The projects are now reset the way a new record gets them: to your
first project, or the default project for a global administrator (or a user with
no project). The same applies when a dataframe link set to delete its target
empties that record.

Records emptied before this update still sit in the default project. An
administrator can find them, and put each one back in the projects it had before
it was emptied, with the new **wiped_filter_projects** check in the Maintenance
area's reconcile panel: run it first without applying to see the list, then apply.
