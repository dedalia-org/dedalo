---
title: Translatable fields in tool forms show the value in your data language, not always in Spanish
type: fixed
audience: user
date: 2026-10-20
wc: WC-2026-10-20-element-context-default-lang
---
Some forms build their fields by asking the server for each field's definition — the
Hierarchy tool's *Name*, for example. When that request named no language, the server
answered Spanish, so a record holding *Unofficial toponymy* in English and
*Toponimia no oficial* in Spanish showed the Spanish value to a user working in English,
and an edit there was saved into the Spanish value.

Those fields now use your current data language, as every other field does.
