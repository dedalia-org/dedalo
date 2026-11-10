---
title: The Hierarchy tool's "Force to create" only rebuilds a hierarchy's own ontology, and deleting a hierarchy record no longer uninstalls an ontology it does not own.
type: security
audience: admin
date: 2026-11-10
breaking: false
wc: WC-2026-11-10-hierarchy-rebuild-ownership
---
Before, "Force to create" deleted every ontology definition of whatever TLD the hierarchy
record named — a core ontology, an installed ontology package or another hierarchy's TLD
included — and deleted it before checking that it could be recreated. Deleting a hierarchy
record did the same, even while another record still declared that TLD.

Now "Force to create" runs only for a hierarchy that owns its provisioned ontology (it is the
only record declaring the TLD, and the TLD holds the virtual sections that hierarchy created).
It deletes those definitions from scratch — own list columns or other custom definitions
included — and recreates them in one step: if the recreation fails, nothing is changed. The
thesaurus terms are never deleted. For any other hierarchy the option is disabled and the tool
says why: a core ontology or an installed package (repair it with an ontology update), a
hierarchy that points at a defined section, a duplicated TLD, or a record that cannot be
provisioned (for example a "Real section tipo" that is not a section). Deleting a hierarchy
record that declares a core TLD, or a TLD another record also declares, is refused. Activating
a hierarchy that points at a defined section no longer creates sections of its own; when no
model section is declared for it, it has no model root, and that is no longer reported as
an error.
