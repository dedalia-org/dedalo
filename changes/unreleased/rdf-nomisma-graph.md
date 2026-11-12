---
title: RDF publication produces real Linked Data (Nomisma).
type: fixed
audience: admin
date: 2026-11-12
breaking: true
wc: WC-2026-11-12-rdf-graph-interpretation
---
RDF publication (Nomisma and other Linked-Data services) now publishes each
record's real graph: subject IRIs from the publication services, typed dates and
numbers, nested nodes, links between published classes, one literal per published
language. Before, the files carried placeholder `urn:dedalo:record:` subjects and
one plain text value per column, which Linked-Data aggregators cannot use.

**Action needed:** an RDF element now compiles only when its definition is
complete — `service_type` and `xmlns` under `properties.diffusion`, and every
class with an `entity_publication_uri` process. An incomplete element is refused
before anything is written, and the publication report names every cause; a
record whose base IRI is missing from the publication services is not written and
is named in the report. See [the diffusion data flow](./diffusion/diffusion_data_flow.md).
