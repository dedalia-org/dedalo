---
title: An installation can now be given its own colour, so several installations open side by side can be told apart.
type: added
audience: admin
date: 2026-11-09
wc: WC-2026-11-09-instance-identity
---
Set `DEDALO_INSTANCE_COLOR="#rrggbb"` in the installation's configuration to turn it on. The colour tints the Dédalo logo in the menu, draws a thin line under the menu bar and colours the developer information bar. The browser tab shows an icon in that colour with two letters of the installation's name, and the tab title starts with `[DEDALO_ENTITY_LABEL]`. Nothing is added to the menu. Without the setting, nothing changes; a value that is not a valid hex colour is reported in the server log and the colour stays off.
