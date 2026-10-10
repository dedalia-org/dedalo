---
title: Thesauri are offered from one exported manifest, hierarchy.json, and nothing but declared dependencies is pre-selected.
type: changed
audience: admin
date: 2026-10-10
breaking: true
wc: WC-2026-10-10-hierarchy-json-manifest
---
The thesauri a release offers at install time, and in *Maintenance › Install hierarchies*, are now listed in one file, `install/import/hierarchy/hierarchy.json`. It is exported from a master installation with the new **Export hierarchy.json** button of *Maintenance › Export hierarchy*. It replaces the three hand-written files `hierarchies.json`, `hierarchies_typologies.json` and `hierarchies_to_install.json`, which are deleted. Each entry describes the thesaurus completely (name, typology, default language, real section, scope note, declared dependencies) and lists its data files with their sha256 checksums.

- **Every listed thesaurus is offered**, with or without data files. One without data files is installed as an empty thesaurus, ready for your editors.
- **Data files are verified before anything is written.** A missing file, or one whose checksum does not match, refuses that thesaurus, and the install reports it. A malformed `hierarchy.json` is refused as a whole rather than offering a shorter list.
- **An entry must fit this installation before its terms are copied.** If its language or typology record does not exist here, or its real section is not a section here, the thesaurus is refused and nothing is imported. An install that was interrupted after the import is finished by the next run. If a thesaurus was installed empty and a later release ships its terms, the install says to use *Reset to seed*; it does not skip it silently.
- **A thesaurus's own dependencies are suggested with it.** Ticking a thesaurus ticks the thesauri its entry declares; you can untick any of them. A thesaurus dependency never stops an install: one you leave out, or one `hierarchy.json` has no entry for, gives a warning that it is strongly recommended and can be installed later. Only a declared mandatory **ontology** this installation lacks stops the import, and the installer says why.
- **Only declared dependencies are pre-selected.** The installers no longer pre-tick Spain or any other thesaurus. Every declared thesaurus is ticked — a mandatory one marked *strongly recommended*, never locked — and nothing else is selected. Both installers suggest importing your own country's toponymy (for example `--hierarchies np` for an installation in Nepal); `--list-hierarchies` prints the codes.
- **A missing data file is no longer an error**, because the thesaurus is created empty.
- **The data export takes an explicit list only.** The `*` (every active hierarchy) and `all` (the whole table) forms are gone. Each tipo must be the thesaurus or model section (`<tld>1` or `<tld>2`) of an active hierarchy. Languages (`lg1`, `lg2`) is refused, because its terms ship in the database seed. **Export hierarchy.json** skips a malformed registry record and names it, and still writes the file for every other thesaurus.
- Thesaurus names in the installers appear in your interface language.
- The install seed now carries only the Languages registry record. Every other thesaurus's record is written from its `hierarchy.json` entry the first time it is activated.

**Action needed** if you added your own hierarchies to `install/import/hierarchy/` and listed them in the old `hierarchies.json`: add their entries to `hierarchy.json`, copied from the source installation's exported `hierarchy.json`. See [Install new hierarchies](./management/install_new_hierarchies.md).
