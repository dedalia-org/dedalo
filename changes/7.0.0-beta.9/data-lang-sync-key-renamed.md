---
title: "The data-language sync setting is now called DEDALO_DATA_LANG_SYNC, as in v6."
type: changed
audience: admin
date: 2026-11-22
---
The setting that keeps the interface language and the data language together was spelled
`DATA_LANG_SYNC` in early v7 installations, unlike its siblings (`DEDALO_DATA_LANG_SELECTOR`,
`DEDALO_DATA_LANG_DEFAULT`). It is now `DEDALO_DATA_LANG_SYNC`, the v6 name, so a v6
configuration carries over unchanged. The old spelling no longer configures anything: if it
is still in `../private/.env`, the update (or the next start) appends the new name with the same
value and keeps the old line.
See [Defining data language sync](./administration/configuration/config.md#defining-data-language-sync).
