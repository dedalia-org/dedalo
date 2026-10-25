---
title: Installing or resetting a thesaurus takes effect at once and no longer needs gigabytes of memory
type: fixed
audience: admin
date: 2026-10-21
---
After *Maintenance › Install hierarchies* installed a thesaurus, or *Reset to seed*
replaced its terms, lists and counts built from those terms could keep showing the old
terms until the server was restarted: deleted terms were still offered and edited
labels still shown. They now refresh as soon as the import finishes.

The import also no longer loads whole thesaurus files into the server's memory. The
largest vendored thesaurus is about one gigabyte once unpacked, and the server needed
more than two gigabytes to import it, enough to be stopped on a modest machine with
every user's request lost. It now reads the files piece by piece. A file that changes
on disk while it is being imported is refused, and nothing of that thesaurus is
changed.

A reset still does not rebuild what other parts of Dédalo derived from the deleted
terms. The result message now says so and names what to run afterwards: the
*observer_mirrors* reconcile, and a new publication or semantic-search reconcile if
the thesaurus is published or indexed.
