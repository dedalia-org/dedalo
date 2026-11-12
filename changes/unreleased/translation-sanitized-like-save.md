---
title: Automatic translation cleans rich text exactly like a normal save
type: security
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-translation-write-value-gates
---
The automatic translation of the language tools (`tool_lang`, `tool_lang_multi`) stored the
translation service's answer without the cleaning a normal save applies to formatted text.
Scripts or event handlers — produced by the service, or by text that was typed literally in
the source language and decoded by the service — could reach the translated language and run
for anyone who opened the record. A translated text area is now cleaned exactly as if it had
been typed and saved, and image links are stored in the same portable form. A translation that
is empty once cleaned is refused instead of blanking the language. Other languages of the
field are not touched; values written by earlier translations are not rewritten.
