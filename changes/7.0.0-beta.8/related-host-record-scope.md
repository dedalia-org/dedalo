---
title: The relations of a record are only shown to users who can open that record.
type: security
audience: admin
date: 2026-10-28
wc: WC-2026-10-28-related-host-record-scope
---
A user with access to a section could ask which records point at any record of that section, including records outside their projects. The same was true of the thesaurus "show indexations" list for a term. Dédalo now refuses that request unless the user can open the record itself, and answers the same way when the record does not exist. Nothing changes for records you can open.
