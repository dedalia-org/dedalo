---
title: Opening a record you cannot access shows the no-access page, and the Relations panel appears only when you may read it.
type: fixed
audience: user
date: 2026-10-27
wc: WC-2026-10-27-start-deep-link-record-scope, WC-2026-10-27-relation-list-grant-stamp
---
Opening a record by its address (a bookmark or a shared link) when the record belongs to a project you do not work in showed an empty form, and the side panel then showed an error message. It now shows the no-access page. A record that does not exist gets the same page, so the page never tells you whether a record you cannot see exists. Administrators are not affected.

The Relations panel in the side panel of a record is now shown only to users whose profile grants it for that section. Before, it was shown to everyone and then refused to open for users without that permission. If the panel cannot be loaded, it now shows a short message instead of an empty list.
