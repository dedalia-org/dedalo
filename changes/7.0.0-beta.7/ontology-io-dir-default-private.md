---
title: Ontology files move out of the code tree by default
type: changed
audience: admin
date: 2026-10-21
---

Unset, `ONTOLOGY_DATA_IO_DIR` now resolves to `<private dir>/import/ontology`. The in-tree `install/import/ontology/` holds the release that ships with the code and is only read. Before, every install resolved to the in-tree directory, because the shipped release made it look non-empty. As a result, ontology updates wrote their staging files and recovery snapshots into the code tree, and the code updater refused every update with "Runtime data lives inside the code tree".

An install whose in-tree directory holds anything that is not an ontology release file (a `recovery/` folder or `.staging` from an earlier update, any other file), or that is an ontology server, keeps that directory and logs a warning at start-up. Nothing is moved. The decision is taken once and recorded. The check goes by file name: an export of your own that carries a release file's name counts as release content. It can be rebuilt from the database, and a code update keeps it in the backup of the old code.

Setting `ONTOLOGY_DATA_IO_DIR=` to an empty value now means the same as leaving it unset. Before, the code updater read the empty value as the code directory and refused.

**One manual step for installs on an earlier release:** the refusal is checked by the code that is already running, so an existing install still refuses this update once. Before updating, run `mkdir <private dir>/import/ontology` as the service user. If you want to keep the old `install/import/ontology/7.0/recovery/` folder, move it there first.

**On an ontology server, copy before you create.** It serves its exports from that directory, and the moment `<private dir>/import/ontology` exists it serves from there instead. Copy every `<major.minor>/` directory from `install/import/ontology/` into it, exports included, then restart. Never create the directory empty.
