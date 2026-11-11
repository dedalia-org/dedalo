---
title: `APPLICATION_LANG` and `DATA_LANG` are deprecated: set `DEDALO_APPLICATION_LANGS_DEFAULT` / `DEDALO_DATA_LANG_DEFAULT` instead.
type: deprecated
audience: admin
date: 2026-11-11
---
The `.env` keys `APPLICATION_LANG` and `DATA_LANG`, and their older spellings
`DEDALO_APPLICATION_LANG` and `DEDALO_DATA_LANG`, duplicated the install-wide default
languages. The current interface and data languages are each user's session choice; the
starting values come from `DEDALO_APPLICATION_LANGS_DEFAULT` and `DEDALO_DATA_LANG_DEFAULT`.

This release still honours the old keys, so nothing changes on update. When one of them
is set and differs from its `*_DEFAULT` key, the server logs a warning at every boot naming
the line and both values; a line equal to its default is only listed, as redundant, in the
`check_config` maintenance widget. The fix is the same for both: set the `*_DEFAULT` key to
the value you want and delete the old line. **From the next release a line that differs
from its default refuses the boot.**

A `DATA_LANG` naming a language the install does not declare is already overruled by
`DEDALO_DATA_LANG_DEFAULT` (unchanged); the widget lists it for deletion — do not copy
its value into the default.

The installer no longer writes these keys, and the v6 configuration migration carries
them only when the v6 config pinned a literal value different from its default (still
honoured, with the boot warning). The server also warns at boot when `DEDALO_APPLICATION_LANGS_DEFAULT` is not
one of `DEDALO_APPLICATION_LANGS`, or `DEDALO_DATA_LANG_DEFAULT` is not one of
`PROJECTS_DEFAULT_LANGS`. See
[Internationalization](./development/internationalization.md#the-language-config-constants).
