---
title: Accounts still on a v6 password can be converted from the Maintenance area
type: added
audience: admin
date: 2026-11-20
wc: WC-2026-11-19-maintenance-legacy-passwords-widget
---

Converting the passwords of a migrated v6 installation needed a command line on the server (`bun run dedalo:migrate-passwords`), and the number of accounts still waiting appeared only in the start-up log.

The Maintenance area now has a **Legacy passwords** panel, for global administrators. It shows how many accounts hold a password, how many are already converted and how many are still on a v6 value and cannot log in. With the two v6 key values (`DEDALO_INFORMATION` and `DEDALO_INFO_KEY`; an empty field stands for the v6 default) **Check** reports how many accounts they decrypt without writing anything, and **Convert passwords** converts them and reports the accounts converted, the ones the values do not decrypt — listed by name and left untouched — and the ones skipped because their password changed meanwhile. Nobody has to choose a new password. The typed values are used for that request only: they are not stored, logged or sent back, and no password reaches the browser.

It is the same conversion as the command, which stays. The panel needs an administrator who can already log in: on a database that comes straight from v6 every password is a v6 value, `root`'s included, so the first conversion is still done with the command. The `/health` notice `legacy_password_accounts` now goes as soon as the panel has converted the last account. See [Migrate the passwords](./install/migrating_from_v6.md#62-migrate-the-passwords).
