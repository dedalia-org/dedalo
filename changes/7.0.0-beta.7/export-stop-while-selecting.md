---
title: Stopping a background export now stops it at once, even while its record selection is still being computed.
type: fixed
audience: user
date: 2026-10-21
breaking: false
wc: WC-2026-10-11-export-buffered-cap-and-admission
---
Pressing Stop on a background export used to wait until the database had finished computing
the export's whole record selection — on a large selection, minutes in which the export kept a
database connection busy for nothing. Now Stop (and the export lane's deadline, and a server
restart) interrupts that computation in the database itself: the export ends as stopped
straight away and its connection is freed.
