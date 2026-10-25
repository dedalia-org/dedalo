---
title: Rich-text fields in a language with no bundled editor translation now open in English instead of not opening at all.
type: fixed
audience: user
date: 2026-10-24
---
The editor that backs the `html_text` view ships a UI translation only for some
languages (70 of the 138 application languages). For the rest — Georgian,
Welsh, Icelandic, Tamil and others — the editor refused to start, so those
fields could not be opened or edited at all.

The editor now falls back to its English interface when its translation file is
not available; the field opens and works as usual. Content and data language are
unaffected.
