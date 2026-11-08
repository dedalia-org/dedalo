---
title: After login, users open on the default section set in their user record.
type: fixed
audience: admin
date: 2026-10-29
wc: WC-2026-10-29-start-user-default-section
---
The "Default section" field of a user record (for example `numisdata6`) was saved but never used. Opening Dédalo without a section in the address now shows that section, provided the user is allowed to read it. If the field is empty, names something that is not a section or area, or names one the user cannot read, Dédalo opens as before: the installation's main section, or the menu.
