---
title: JSON fields are lighter and faster
type: changed
audience: user
date: 2026-10-30
---

The JSON component loads its search and mini/text/collapse views only when used, list cells preview a large value without serializing all of it, typing in the editor no longer re-parses the whole value on every keystroke, closing a record releases its JSON editors, and the JSON download no longer builds a percent-encoded copy of the value.
