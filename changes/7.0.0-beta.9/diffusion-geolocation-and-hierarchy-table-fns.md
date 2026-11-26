---
title: Publishing hierarchies and text-area geolocation fields no longer reports errors and leaves empty columns.
type: fixed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-diffusion-map-target-section-tipo
---
Two publication functions were not implemented, so every published record raised an error
("Partial success") and the column stayed empty. Publishing the `hierarchy` table now
writes each thesaurus's target table name (for example `ts_onomastic`), and the flat
geolocation column of text-area fields (`get_geolocation_data`) publishes its layers as
`{type, lon, lat}` points. Republish the `hierarchy` table and the tables holding those
geolocation fields to fill the columns written empty before. See
[the diffusion engine](./diffusion/native_engine.md).
