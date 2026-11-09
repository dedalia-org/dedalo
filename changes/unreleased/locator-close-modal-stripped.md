---
title: Records linked from the list's link button no longer store the stray `close_modal` key in their locator.
type: fixed
audience: user
date: 2026-11-09
breaking: false
---
Linking a record with the link button of a portal's list view saved the button's own "keep the window open"
flag (`close_modal`) inside the stored relation, next to the real locator keys. The flag is now kept out of the
locator by the client and stripped by the server's relation insert. Locators already saved with it are harmless
to read; removing the key from them restores the clean locator shape.
