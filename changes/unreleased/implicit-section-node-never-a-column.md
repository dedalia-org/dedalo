---
title: A relation list that names two sections resolves to the last one, and never shows a section as a column.
type: fixed
audience: admin
date: 2026-11-21
wc: WC-2026-11-21-implicit-section-node-never-a-column
---
When the ontology relations of a field without its own request configuration — or of a
list definition — name more than one section, the engine now takes the LAST one as the target
section and shows none of them as a column. Before, it took the first and emitted the others
as columns that no view could draw, and the columns were read from the wrong section. An
ontology whose nodes name a single section is unaffected.
