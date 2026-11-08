---
title: A refused maintenance action now shows the server's reason in the panel, not only a generic sentence.
type: fixed
audience: admin
date: 2026-11-08
---
When a maintenance action was refused — for example *Build developer release* on a code server whose `master` is the tagged commit of a beta — the panel showed only "The update was refused in the current state", and the reason that says what to do was visible only in the browser console. The panel now shows the reason under that sentence ("'master' is the tagged commit v7.0.0-beta.8 … build an untagged commit").
