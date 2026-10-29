---
title: The test ontology's "Countermark descriptions" section tool now opens its target section.
type: fixed
audience: developer
date: 2026-10-28
wc: WC-2026-10-28-section-tool-test6402-config
---
The test ontology's copy of the "Countermark descriptions" section tool (test6402) used an old setting name that the engine does not read, so it could not open. It now uses the current name, matching the fix on the master ontology. Tests that need a section tool without a target build their own.
