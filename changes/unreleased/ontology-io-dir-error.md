---
title: Ontology update and export now say why the ontology directory cannot be created.
type: fixed
audience: admin
date: 2026-10-26
---
When the engine could not create the ontology exchange directory (`ONTOLOGY_DATA_IO_DIR/<major.minor>`), **Maintenance → Update ontology** answered only `unable to resolve the ontology IO directory`, and the export actions answered `Unable to create directory: false`. They now name the directory and the system error, for example `EACCES` when the service user cannot write to it. The usual fix is to give the service user ownership of that directory, or to point `ONTOLOGY_DATA_IO_DIR` at a writable one.
