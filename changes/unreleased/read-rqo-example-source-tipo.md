---
title: The section read example in the API field mapping names the section in source.tipo and lists it in sqo.section_tipo.
type: fixed
audience: developer
date: 2026-10-26
---
Before: the `read` request example set only `source.section_tipo` and no `source.tipo`, which a section read refuses with `request.invalid_source`.
Now: the example sets `source.tipo` to the section's own tipo and `sqo.section_tipo` to the list of sections to read, and the field list states both as required for a section read: `source.tipo`, and `sqo.section_tipo` in every `sqo`.
