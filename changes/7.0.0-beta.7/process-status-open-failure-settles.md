---
title: A maintenance job whose progress cannot be followed now says so instead of waiting forever.
type: fixed
audience: admin
date: 2026-10-23
---
When the progress of a long job (a backup, a code update, a move of terms or languages) could
not be followed at all — the connection failed, the server refused the request, or it answered
without any content — the panel kept showing what it showed before, and a move whose run could
not be followed kept its form locked ("an execute is still running") until the page was
reloaded. The panel now states the failure inside the panel, with the request id to look up in
the server log, and the form is released. A refusal there never turns the whole page into an
error page.
