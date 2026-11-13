---
title: Long values in search-form autocomplete fields are readable again.
type: fixed
audience: user
date: 2026-11-13
---
In the search form, a long value without spaces (e.g. the ontology model "component_relation_children") ran past the right edge of the autocomplete result list, and once chosen it broke mid-word with its remove button pushed onto a line of its own. The result list now widens to fit its rows, and the chosen value wraps only after an underscore, with the remove button beside it.
