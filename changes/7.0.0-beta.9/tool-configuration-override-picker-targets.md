---
title: A Tools configuration record that points a picker tool at another section lets that section's records be linked.
type: fixed
audience: admin
date: 2026-11-13
wc: WC-2026-11-12-tool-configuration-override
---
A Tools configuration record (or a register default) can redefine a tool's components
for one field. When it points the indexation or cataloguing tool at a section the
ontology does not name, the picker offered that section's records but saving the
link was refused ("off target"). Now the saved link is accepted exactly where the
picker offers it; a section named by neither the ontology nor a configuration record
is still refused. Editing the configuration record takes effect on the next save. The
per-entry precedence (configuration record, then register default, then ontology) is
confirmed.
