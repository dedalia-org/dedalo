---
title: The ontology now stores model, table and column names as language-free machine names.
type: changed
audience: admin
date: 2026-11-04
wc: WC-2026-11-04-ontology-machine-names
---
A model name, a publication table or column name, an rdf/owl class name and the diffusion
domain are identifiers, not translations. Until now they were read from the node's Spanish
term. Each ontology node now says whether it is named by a **machine name** (one value, no
language) or by its translatable label, and the runtime ontology keeps that name in its own
column. On the first start after the update the server fills it for every installed
ontology; nothing changes in what you see or publish. The ontology health check also names
nodes whose machine name is missing or ambiguous (several different candidate names), so you
can fix them at the source.

Everything that uses such a name (the publication databases, tables and columns, the matrix
table of a section, rdf import) now reads the machine name, never a translation, so a stray
translation can no longer become a table or column name. A node with no label in any
language shows its machine name in the interface. The `DEDALO_STRUCTURE_LANG` setting keeps
its value but now only chooses the language ontology labels fall back to; it no longer
affects any name.

Once your ontology defines the two new fields, saving an ontology node checks them: a node
that uses a machine name must keep one (a single value, without surrounding spaces or
control characters), a node that does not use one cannot be given one, a model change that
would need a machine name asks you to set "Use machine name" first, and a local override
cannot switch the setting. The error names the node and what to do. Time Machine restores
are never refused: a name restored from before the change is moved into the machine-name
field.

Once your ontology defines the two fields, the server also converts your ontology records to
the new shape by itself, but only where nothing you see or publish changes: the name moves
from the Spanish term into the machine-name field and each node states whether it uses one.
Imported ontology packages are converted the same way. Nodes whose other languages hold a
different text (which would then become the label a Spanish screen shows) are listed for
root under Maintenance › Reconcile (`ontology_machine_names_strays`); nodes with several
candidate names are listed and never guessed. On an ontology server nothing is converted
automatically: an administrator runs it per TLD.

A section whose matrix table node has no machine name (missing, or several candidate names)
is now refused with an error that names both nodes, instead of silently reading and writing
the default table. A machine name, once set on a node that uses one, cannot be emptied (to
rename, write the new name). On an ontology server, imported ontology packages are never
converted automatically.

In the thesaurus and ontology trees a term that resolves empty in every language is no longer
a blank line: it shows a marked **Missing term** placeholder, and its tooltip names the
components the section's `section_list_thesaurus` term definition reads. Either the record has
no value, or the definition does not name the component that holds it; both are worth fixing
at the source rather than living with. The tree never substitutes another field on its own:
what a term shows is decided only by the section's definition. In the ontology tree a node
whose "Use machine name" is Yes shows its machine name in place of its label, and clicking it
opens the machine name for editing; any other node shows, and opens, its label.
The ontology tree's model badge (Ctrl+M) follows the same rule: a model whose "Use machine
name" is Yes is shown by its machine name, so the badges are not empty once your ontology
stores model names in the machine-name field.
