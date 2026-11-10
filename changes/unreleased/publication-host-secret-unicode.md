---
title: Publication host install accepts passwords with accented letters (ñ, ç, ü…) and any language's letters.
type: fixed
audience: admin
date: 2026-11-10
---
When the publication host install asks for the database password and the v1
`API_WEB_USER_CODE`, it refused any character outside plain ASCII, so a password such as
`Contraseña#ç` could not be used. Now any visible character is accepted: letters of any
language and symbols such as `!#%&+-_@`. It is written to the API configuration files exactly
as typed, even when a paste or a slow SSH link delivers a character in two pieces.

Still refused: spaces, characters that show as nothing (zero-width, variation selectors — so
also emoji written with one, such as ❤️), `'`, `\` and `$`. The v2 configuration file is
read by Bun, which treats `$` specially even inside quotes, so v2 would read a different
password.
