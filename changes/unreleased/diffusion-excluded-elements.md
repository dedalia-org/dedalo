---
title: Diffusion elements excluded in the tool configuration are hidden and refused again.
type: fixed
audience: admin
date: 2026-11-22
wc: WC-2026-11-22-diffusion-excluded-elements
---
v6's `EXCLUDE_DIFFUSION_ELEMENTS` hid the listed diffusion elements from the
publication panel; v7 had dropped the setting, so every element was offered and
published to. It is back as the `EXCLUDE_DIFFUSION_ELEMENTS` key of `tool_diffusion`
in **Tools configuration**: a listed element (or an alias of it) shows no panel, and
the server refuses a publication to it with `diffusion.element_excluded`, however the
request is sent. A value that is not a list of element tipos refuses both until it is
fixed. Unpublishing is never blocked. The v6 → v7 configuration migration moves the
old define into this key on `--execute`. See the
[tool_diffusion reference](./development/tools/reference/tool_diffusion.md) and
[Migrating from v6](./install/migrating_from_v6.md).
