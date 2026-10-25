---
title: The acquisition tools no longer let you start a second import while the first one's outcome is unknown
type: fixed
audience: user
date: 2026-10-21
---
In the auction-catalogue and journal acquisition tools, **Confirm import** stays
disabled while the server has not said what an import did. Three ways around that
could still start a second import beside the first:

- Running **Preview** again replaced the review, including its disabled **Confirm**,
  with a new one you could click. **Preview** is now disabled until the import's
  outcome is known, or until you choose to try again.
- An import that ended without saying what it did turned **Confirm** back on by
  itself. That happens when the server process running it stopped, when it was
  stopped partway, or when the server could no longer find it. The panel now shows
  the server's own message, asks you to check the records, and turns **Confirm**
  back on only when you say so.
- **Check my jobs** offered "It did not start: allow a new attempt" even when it
  listed an import of the same kind that had just finished, which might be the one
  you started. You now open that import first to see what it did. When no import of
  that kind is running or finished recently, the button now says only that, and
  leaves the decision to you.
