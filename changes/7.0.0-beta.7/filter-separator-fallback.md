---
title: Plain-text filter values join terms with ', ' when the section map defines no separator
type: fixed
audience: user
date: 2026-10-18
---

component_filter in the 'text' list view smashed its selected terms together
when the section context supplied no `fields_separator` ("MIB
AntigüedadBibliografíaMIB medieval-moderno"). An absent separator now falls
back to ', '; a separator the context does define — empty included — is
respected as before.
