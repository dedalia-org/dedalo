---
title: A running move execute in Maintenance can no longer be hidden by a new Preview
type: fixed
audience: admin
date: 2026-10-22
---
In the five Maintenance move widgets (move languages, locators, TLD, to portal, to
table), clicking **Preview** while an **Execute** was still running replaced the
execute's progress panel and the record that lets a reloaded page find it again.
The result of the execute (completed, rolled back, partly applied, or unknown) was
never shown, so it was easy to run the same move a second time. While an execute
runs, **Preview** and **Execute** now explain why they wait instead of starting a
new run. A reloaded page reconnects to a running execute and keeps it in front.
If the server did not confirm an execute, the widget waits for a page reload
before it starts another run.
