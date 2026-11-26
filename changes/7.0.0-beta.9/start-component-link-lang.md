---
title: A link that opens a single field now shows it in the right language.
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-start-component-lang
---
Opening one field of a record directly (a link with `tipo=<field>`) showed and saved it in the
working data language even when the field is not translatable, so a number or a code was filed
under a language. The field now follows its own rule: a translatable field opens in the language
the link asks for (`lang=…`), or the working data language; a non-translatable field has no
language; a field with transliterations opens in the asked language or its base. A link whose
`lang` is not a language code is refused instead of guessed. Pages that open a whole section or
area are unchanged. Details: [the start action](./core/system/api.md).
