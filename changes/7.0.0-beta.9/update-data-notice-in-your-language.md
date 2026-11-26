---
title: The Update-data panel's "Not updated" notice is shown in your language
type: changed
audience: admin
date: 2026-11-20
wc: WC-2026-11-19-data-version-unreachable
---

The notice the **Update data** panel shows for a database of an earlier major version ("Not updated: the database is on data version 6.9.1 …") was written in English whatever the language of the interface. It is now a text of the interface like the others, translated in every language Dédalo ships, with the versions and the manual page filled in.

For API consumers: the panel value keeps `notice` (the English sentence) and adds `notice_data`, the facts it is made of.
