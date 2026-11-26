---
title: A component whose list configuration names no section now reads from the caller's own section.
type: fixed
audience: developer
date: 2026-11-25
wc: WC-2026-11-25-implicit-component-target-caller-section
---
A component without an explicit `request_config` builds its configuration from its ontology
relations. When those relations named columns but no section, the configuration came out
with an empty target (`sqo.section_tipo: []`): columns with nothing to read them from. It
now targets the section the component is shown in, as earlier Dédalo versions did. A section
named in the relations, or the component model's own default target (the typology selector),
still wins, and a component with no relations at all still gets no configuration; an index
component never reads from its own section, and a relation to a storage table is no longer
emitted as a column (a component related only to one gets no configuration). Every door
built on the same configuration — the record picker, the option lists, the import target
check and the new-record target check — now sees that section too. The
projects-administration filter of a user record relates to the projects section in the
shipped ontology, so it keeps its projects list.
