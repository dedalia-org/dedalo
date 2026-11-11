---
title: The login page now opens in the installation's default interface language.
type: fixed
audience: admin
date: 2026-11-11
---
When `DEDALO_APPLICATION_LANG` was not set in `.env`, the login page and any session that
had not picked a language used Spanish (`lg-spa`), ignoring
`DEDALO_APPLICATION_LANGS_DEFAULT`. An unset `DEDALO_APPLICATION_LANG` now means the value
of `DEDALO_APPLICATION_LANGS_DEFAULT`, and an unset `DEDALO_DATA_LANG` means the value of
`DEDALO_DATA_LANG_DEFAULT`. An installation that sets either key explicitly is unchanged.
