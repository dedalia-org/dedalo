---
title: The "Report a problem" tab only appears for users whose profile grants the error-report tool.
type: fixed
audience: user
wc: WC-2026-10-21-error-report-granted
date: 2026-10-21
---

An administrator whose profile does not include **Error report** still saw the purple "Report a problem" tab on the right edge; clicking it only answered "The tool is not active or not authorized for your user".

The server now tells the page whether the tool is granted (no extra request), and the tab shows only then, so it appears exactly for the users who can use it: those whose profile includes the tool, and the superuser. To give an administrator the tab, add **Error report** to their profile's tools.
