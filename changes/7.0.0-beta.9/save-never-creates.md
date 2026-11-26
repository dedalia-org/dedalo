---
title: Saving a field of a record that does not exist (or was deleted) is refused instead of creating the record.
type: fixed
audience: admin
date: 2026-11-10
breaking: false
wc: WC-2026-11-10-save-never-creates
---
Before, a save addressed to a record number with no record behind it (possible for a global
administrator, the assistant or a tool working with a stale or mistyped number) silently
created a record at that number, without asking for permission to create in the section,
and could bring a deleted record's number back to life as a new, empty record.

Now such a save is refused with a "not found" message that says which case it is: the record
does not exist (create records with **New**), or it was deleted (restore it from **Time
Machine**). Nothing is written. A spreadsheet import row whose record was deleted while the
import was running is reported as failed instead of being recreated.
