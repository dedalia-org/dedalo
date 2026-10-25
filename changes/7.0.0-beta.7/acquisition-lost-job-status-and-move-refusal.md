---
title: The acquisition tools no longer go silent when a job's progress is lost, and the move panels show a refused run.
type: fixed
audience: user
date: 2026-10-21
---
In the auction-catalogue and journal acquisition tools, if the connection that
reports a preview's or an import's progress dropped before the job finished, the
panel showed nothing more and re-enabled its button, although the job could still be
running on the server. Clicking again could start a second import beside the first.
The panel now says that it lost the job's status and that the job may still be
running, keeps the button disabled, and offers **Check again**, which reconnects to
the same job.

In the auction-catalogue tool's company picker, a slow first search for the auction
house could answer after a newer search you had typed, and replace your choice of
Entity with the old one. Only the latest search now counts. A search that fails is
shown as an error, not as "no candidates" with *Create new Entity* already selected.
**Confirm** also waits until the Entity is chosen, so an import never drops the
auction's company link without telling you.

In the maintenance move panels (move TLD, language, locators, to portal, to table),
a run the server refused, for example because of a bad option, used to show nothing
in the panel. The panel now shows the reason, the server's own sentence, and the
request id.

For developers: with `SHOW_DEBUG` on, the browser console's request line now lists
only the names of a request's options and hides their values. Before, it hid only
some secret keys and printed the login password.
