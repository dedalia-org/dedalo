---
title: The Reconcile panel offers *Apply* only where you can apply, and a refusal no longer replaces the page
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-09-03-maintenance-reconcile-status-widget
---
In *Maintenance → Reconcile*, every row showed an *Apply* button. Two of them could not
work for most people: *media_copy* applies only for the root user, and *publication_apis*
never applies there at all (Publication API code is pushed from the publication-hosts
panel). Clicking either one showed the no-access page in place of the panel.

Now each row knows who may apply it. Where you cannot, *Apply* is disabled and its tooltip
says why. *Check* (the dry run) works as before on every row.
