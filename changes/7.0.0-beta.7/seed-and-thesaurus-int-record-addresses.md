---
title: New installations and imported thesauri store record references in their final form
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-seed-and-thesaurus-int-clean
---
Every reference from one record to another names the target record by number. Dédalo
stores that number as a number, but a fresh installation was born with thousands of
references written as text (the administrator account's profile and project, the
languages, the core ontology), and installing or resetting a thesaurus from
*Maintenance › Install hierarchies* copied the text form of the vendored files as it
was. Searches matched both forms, so nothing looked wrong, but the text form is what
the planned clean-up of old installations removes. Now a new installation and every
thesaurus you install or reset store numbers only, and a new installation records that
its data is already in the final form. Nothing else in the data changes.
