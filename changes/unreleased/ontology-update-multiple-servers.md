---
title: The ontology update lists what a server offers by name, and several ontology servers can be used side by side.
type: changed
audience: admin
date: 2026-11-07
breaking: false
wc: WC-2026-11-07-ontology-update-picked-source
---
**Maintenance → Update ontology** used to offer a row of bare tld chips (`es`, `fr`, `oh`…) and a *Fetch list* button. Picking a server now lists everything it offers, grouped by typology, each with its name in your language and what ticking it does here: **New**, **Installed**, or **Installed · not tracked** — installed here but not in `ACTIVE_ONTOLOGY_TLDS`, possibly your own local ontology. The panel warns when one of those is ticked. A filter, **Selected only**, **Default selection** and **Clear** make a 200-ontology list manageable. The shared value lists (`matrix_dd`) are now a row you tick like any other.

**Several ontology servers now work.** The update takes the ticked ontologies from the server you picked — any ontology it offers, even outside `ACTIVE_ONTOLOGY_TLDS` — so an installation can take its shared ontologies from the official server, its own from an institution's server, or try a test server's version. Two servers on the same host under different paths are told apart. The automatic update that rides a code update takes from the first server in `ONTOLOGY_SERVERS`, unless entries declare a `tlds` list. Before, a second server without a `tlds` list made every update fail.

**Replace selected ontologies now opens a confirmation dialog**, like the code update: the version change, the ontologies that will be replaced and from which server, a warning for ticked *not tracked* ones, and — only when there is no recent database backup — the **Update without a recent database backup** box beside the button. The backup box is no longer in the panel.

**The update shows its progress.** It now runs in the background, like a code update, and the panel follows it with a progress bar naming the stage (downloading, importing, processing, finishing) and the ontology in work. A long update no longer depends on one browser request staying open.
