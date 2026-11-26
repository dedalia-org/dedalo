---
title: "A refused language change no longer clears open sections or leaves the selector on the refused language."
type: fixed
audience: user
date: 2026-11-22
---
When the server refuses a language chosen in the menu, the open sections keep their loaded
content (nothing was changed, so nothing is reloaded) and the selector goes back to the language
the session is actually using, next to the error that explains the refusal.
