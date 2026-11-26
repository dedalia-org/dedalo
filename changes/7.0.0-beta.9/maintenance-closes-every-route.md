---
title: Maintenance mode now closes every route to non-root sessions, not only the API
type: security
audience: admin
date: 2026-11-19
---

While maintenance mode was on, the API refused every session but `root`'s, but the routes that do not go through the API still answered a logged-in user: media and staged-upload files, model weights, the text-area tag redirect, a file upload, the environment view and — for a global administrator — the raw record view, the counters and the hierarchy dump download.

Now all of them read the session through one gate and answer a non-root session exactly as they answer an anonymous caller (not found) until maintenance is lifted. `root` is served throughout. See [Maintenance-mode gate](./core/system/login.md#maintenance-mode-gate).
