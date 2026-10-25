---
title: Deleting or restoring an ontology record now removes or restores its runtime node.
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-ontology-record-lifecycle
---
Deleting an ontology record (or emptying its data) left its node in the runtime ontology, still
served everywhere; restoring a deleted record from the Time Machine brought the record back
without its node. Both now move the node with the record, in the same transaction. A local
override follows the same rule: deleting or restoring it re-applies the node it overrides.
Writing a record's content into the runtime ontology stays a developer action: when a user who
is not a developer restores a record, or deletes or restores an override, the record changes
but the node does not, and the ontology inspection lists it as drift for a developer to apply.
The same holds when no user is identified at all (for example a write through the stdio MCP
server): only a developer's action writes node content.
An ontology rebuild, a registry activation and a record delete or restore on the same TLD no
longer race each other, and activating a TLD while it is being deleted no longer leaves its root
node behind.
See [Ontology write pipeline](./core/ontology/ontology_write.md).
