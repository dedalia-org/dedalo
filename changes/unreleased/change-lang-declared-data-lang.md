---
title: Choosing a data language the installation does not have is refused.
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-change-lang-declared-data-lang
---
The data-language selector stored any language code it was sent, so a session could
end up editing and reading in a language the installation does not catalogue in —
values written there were reached by no other view, and the identification tool's
grouping run refused it. Now a data language that is not one of the installation's
data languages is refused and nothing is stored. When the installation couples the
two languages (`DEDALO_DATA_LANG_SYNC`), changing the interface language changes the
data language only if that language is also a data language, and changing the data
language changes the interface language only if the installation has an interface in
it; otherwise the other language stays as it was — the same rule applies when logging in adopts the language
chosen on the login panel. A session that already holds a data language the
installation does not have works in the installation's default data language instead.
An interface language the installation does not offer is refused too.
The identification tool's grouping run applies the same
rule to the language it is given or, when none is given, to the session's. See
[Internationalization](./development/internationalization.md).
