---
title: Updates check what the master offers, and masters must use https.
type: changed
audience: admin
wc: WC-2026-10-30-update-sources-server-held
date: 2026-10-30
---
"Update ontology" now reads the master's ontology list itself. It refuses an ontology exported for another data model, and a database that still needs "Update data" first. Each file is taken from the master's own list, not from the browser. With several ontology masters, each entry in `ONTOLOGY_SERVERS` lists the ontologies it provides in `tlds`, and every ontology must come from exactly one master. "Update code" now checks that the selected master really offers the chosen release with that checksum before downloading it. Code and ontology masters must use `https://`: an `http://` entry is ignored, with a message in the server log. Plain http works only for a master on the same machine.
