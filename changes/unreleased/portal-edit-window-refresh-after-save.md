---
title: A record edited in its own window now shows the saved value in the list or field that opened it.
type: fixed
audience: user
date: 2026-11-10
---
Editing a linked record from a portal (or a select, check box, filter, thesaurus term or list row) opens it in a separate window. Before, the original window refreshed once, as soon as you came back to it — often before the edit had finished saving, so it kept showing the old value until the page was reloaded, and later edits in the same window never refreshed it at all. Now the original window refreshes after every field save the edit window completes, including the last one made while closing or reloading it. Other changes made in that window (creating, deleting or duplicating records, tool actions) still refresh it once, when you return to it.
