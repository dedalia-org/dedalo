---
title: The acquisition tools and move panels no longer re-enable an action when the server did not confirm whether the job started.
type: fixed
audience: user
date: 2026-10-21
---
In the auction-catalogue and journal acquisition tools, a preview or an import
whose start the server never confirmed (the request timed out, the connection
dropped, or the server answered that the same request was still in progress or
its outcome was unknown) used to re-enable **Confirm** as if it had been refused.
Clicking again could start a second import beside the first. The panel now says
the job may be running and keeps the button disabled. **Check my jobs** lists your
jobs of this kind: **Show this job** follows the one that started, and a new attempt
is offered only when none of them is running or queued.

The action buttons are now truly disabled while a job runs, so the keyboard can no
longer start the same job twice. A job status that falls silent, or stops halfway
through, is declared lost after 15 seconds, with **Check again** to reconnect to the
same job.

In the maintenance move panels (move TLD, language, locators, to portal, to table),
a run whose start the server did not confirm is no longer shown as refused: the
panel says it may have started and asks you to check before running it again.
