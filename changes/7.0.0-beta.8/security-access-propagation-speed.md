---
title: Setting permissions on a large area is faster, and a failed change no longer locks the permissions tree.
type: fixed
audience: admin
date: 2026-10-27
---
Ticking an area or a permission in a profile's access permissions updated every child by searching the whole permission list again, so large areas took long to apply. Each update is now immediate. And if applying a change ever failed, the permissions tree stayed greyed out and ignored clicks, filter included, until the page was reloaded; it is now always released, and a failed save no longer leaves the tree locked either.
