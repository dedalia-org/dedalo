---
title: Ontology dependencies are declared in the master's *Dependencies* field, say whether an ontology or a thesaurus is needed, and can be optional.
type: changed
audience: admin
date: 2026-10-10
wc: WC-2026-10-10-ontology-dependencies-hierarchy60
---
An ontology master now declares what each ontology needs in the *Dependencies* field
(`hierarchy60`) of its *Ontologies main* record. This replaces the *Required ontologies*
field from the previous build. That field is removed automatically from every
installation at its next start. Its values are not converted, so a master that filled it
must declare them again in *Dependencies*.

Each dependency names a TLD and says whether its **ontology** or its **thesaurus** is
needed, and whether it is **mandatory**.

* **Installing.** The installer always installs mandatory dependencies. It offers
  optional ones already ticked, and you may untick them, in the wizard or with
  `--decline-dependencies`. A required thesaurus that the release does not ship stops
  the install before anything is written.
* **Updating.** An update reports each missing mandatory dependency under *Import
  warnings*, together with how to provide it. It never installs one on its own.

The ontology registry also keeps local decisions through imports and rebuilds. A
domain ontology you switched off stays off, and its project filter is kept. Each
ontology is filed under the installation's own structure language, not a fixed one.

See [Declaring what an ontology requires](./management/updates/updating_ontology.md#declaring-what-an-ontology-requires).
