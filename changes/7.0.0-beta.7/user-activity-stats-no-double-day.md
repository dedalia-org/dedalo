---
title: Rebuilding or updating one user's activity statistics never counts a day twice
type: fixed
audience: admin
date: 2026-10-21
breaking: false
---
Two rebuilds of the same user's activity statistics running at once, or a rebuild and an update, could each save the same day, so that day's totals appeared twice. Every writer of one user's statistics now waits for the other, and a day already saved is never saved again.
