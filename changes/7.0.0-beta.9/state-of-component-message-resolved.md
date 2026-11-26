---
title: "The tooltip of a component's state icon (an alternative or deprecated field) shows readable text in your language, naming the field it points to — no longer a label key."
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-state-of-component-msg-refused
---
A field marked in the ontology as an alternative to, or replaced by, another field shows a
state icon whose tooltip explained the situation with an untranslated key
(`component_alternative`). The tooltip now reads as a sentence in the interface language and
names the other field by its label. A message the ontology declares wrongly (a key that is not
a label, or a sentence with no field to name) is left out rather than shown as code, and is
logged for the ontology's author.
