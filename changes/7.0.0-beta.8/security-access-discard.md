---
title: Profile permissions can be discarded before saving.
type: added
audience: admin
date: 2026-10-29
---
The permissions tree of a user profile now shows a Cancel button next to Save once a value changes. It asks for confirmation, then reloads the stored permissions, so a value changed by accident can be undone without saving it. Setting a value back to its saved level hides both buttons and the "Unsaved changes!" warning again.
