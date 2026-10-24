---
title: An administrator's saved search in the Time Machine list survives a reload.
type: fixed
audience: user
date: 2026-10-23
wc: WC-2026-10-22-tm-scope-whole-request
---
A history list now never takes a remembered search of another section from the session
(see the entry on *Latest changes* and *Component history*). In this release's first build
that rule also applied to the Time Machine list an administrator opens on its own, with no
section named: a reload dropped the administrator's saved search and showed the whole
history, and the saved search was overwritten with the empty one.

The rule now applies only to a history list opened for a section, for every user,
administrators included. The administrator's own Time Machine list keeps its saved search
across a reload. That list stays refused for any user who is not an administrator.
