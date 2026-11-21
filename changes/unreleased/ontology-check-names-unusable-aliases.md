---
title: The ontology check names alias components that point at a component they cannot stand in for.
type: added
audience: admin
date: 2026-11-21
---
A `component_alias` shows another component under its own name and configuration. That works for
portals and for plain value components (text, date, number…); an alias of any other kind of
component — a select, a media component, a section id — cannot be read, and the engine refuses
it when a user opens the form. The ontology status (Ontology parser tool) and the message of an
ontology rebuild or update now name every such alias by its source record, so it is found when
the ontology is updated. The fix belongs in the ontology: change the alias's `alias_of`.
