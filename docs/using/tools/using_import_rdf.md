# RDF import (`tool_import_rdf`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_import_rdf.md)

Import an external linked-open-data resource, named by an IRI in a record, into that record: its labels, descriptions, dates and places, and links to the related records (mint, authority, material…), which are found or created.

!!! info "This is an advanced, ontology-driven tool"
    Which RDF types and properties map to which sections and components is described in the ontology by an administrator, as an *External Ontology*. A cataloguer runs the import; the mapping is a setup step.

## What it's for

Heritage records often link out to a shared authority — a coin type in Nomisma/OCRE, a place in GeoNames, a term in a Dublin Core vocabulary — by storing that resource's IRI in an IRI component. This tool reads that resource and writes its data into your record, instead of you copying it by hand.

Concrete scenario: a numismatist cataloguing a Roman coin type has pasted the OCRE IRI `http://numismatics.org/ocre/id/ric.1(2).aug.1A` into the record's IRI component. They open the RDF import on that component, pick the IRI and run it. The tool fills the record's empty fields — the title in every language OCRE gives, the definition, the date range, the reference number — and links the record to its mint, denomination, material and authority. Those it finds already in Dédalo (by their Nomisma IRI) are linked as they are; the others are created from Nomisma's own data and then linked.

## When to use it

- A record holds an external LOD IRI, and the section's IRI component is paired with an External Ontology that describes the vocabulary.
- You want the resource's data in the record, and its related authorities linked.

When NOT to use it:

- For bulk file loads, use the file-based importers: [CSV import](using_import_dedalo_csv.md), [MARC21 import](using_import_marc21.md), or [Zotero import](using_import_zotero.md). This tool imports one IRI per run from a live remote graph.

## Where to find it

The tool is **component-level**: it renders as an **Import RDF** button inline on a configured `component_iri` field, in edit mode, on records whose `tipo` matches the tool's configuration. It does not appear on section toolbars or the inspector — only next to the IRI field it is wired to.

## Using it, step by step

1. **Make sure the record's IRI component holds a valid external IRI** for a vocabulary that has been described in the ontology.
2. **Open the record in edit mode** and find the **Import RDF** button next to the IRI field.
3. **Pick the IRI value** with the radio button (a component can hold several IRIs).
4. **Choose a default language** for texts that arrive without a language tag.
5. **Click OK.** The tool fetches the resource, writes into the record and the records it links to, and shows what it did: the records it **created**, the fields it **wrote**, and what it **skipped** and why. The parsed RDF is under a collapsed *RDF* heading. The record refreshes so the new data shows.

## Tips and gotchas

!!! warning "The import writes — but never overwrites"
    Running the import changes your data. It only **fills**: a text is written only where that field is empty in that language, an IRI or a link is added only when it is not there yet, and a single-choice field is set only when it is empty. Your own values are never replaced; the report lists each one it left alone (*not empty in lg-eng — never overwritten*). Running the same import twice changes nothing the second time.

!!! note "Every run can be reverted"
    Each run that changes something is recorded as one bulk process (its number is shown under the report). Its changes can be undone together from the time machine's bulk revert. A run that changes nothing records none.

!!! note "One refused value never costs the rest"
    When Dédalo refuses one value of the resource (a link the field does not accept, a field you may not edit), that value is listed under **skipped** with the reason, and everything else is still written. A link the External Ontology maps to a section the field does not accept says *ontology … maps …, but … targets … — fix the ontology node*: an administrator corrects that node, and the next run links it. A related record (a mint, a person) is never created without the identifier that finds it again: when that value cannot be written, nothing of it is created. One the import created stays when only its link is refused (the field is full, the term is not selectable): the next run that may link it finds it, and never creates a second one.

!!! note "Related records: found first, created only when new"
    A related authority (a mint, a material, a person) is first looked for by its IRI, in every project — also in projects you do not work in. If a record already has it, that record is linked and nothing is fetched; it is never duplicated (you can only change its own fields if it is in your projects). Only a new one is fetched from its own site, created with its labels, and linked. Before creating it, the tool also looks for its *equivalent* IRIs (for example the Getty or Wikidata addresses its page lists as the same concept): if exactly one record already has one of them, that record is linked instead, and the authority's IRI is added to it (if you may change that record), so the next run finds it at once. The same address under `http://` and `https://` counts as one; any other difference (a trailing slash, for example) does not. Only the authority's address is added to the record found this way: its other fields from the source are not written into it, and the report lists them as skipped. If several different records have them, nothing is linked or created, and the report names those records: merge the duplicates and run the import again. If you cannot write in that section, it is not created, and the report says so.

!!! note "Skipped texts"
    A text in a language your installation does not have is not written, and the report says *language_not_installed*. A text from the source that contains Dédalo tag syntax (such as `[index-…]`) is never written either: it would turn into a real tag in your record.

!!! note "Intermediate records (creators)"
    Some links go through an intermediate record, such as a creator that points to a person. The creator is created only together with its link to that person. If the person cannot be resolved (two records share its IRI, or it could not be fetched), no creator is created, and the report says *intermediate not created*: fix the cause and run the import again.

!!! note "Not fetched — run again"
    Each IRI has 15 seconds in total, including the related authorities the tool has to fetch, and requests to the same site are spaced a few seconds apart. A related authority that does not fit in that time (or whose site is not answering) is **not linked** in this run, and the report says *not fetched — run again*. Run the import again: what was imported is found, and the tool continues with what is left. An authority whose page cannot be read at all is created with its IRI only, and linked.

!!! note "Only outbound web IRIs are fetched"
    For safety the tool only fetches ordinary `http`/`https` IRIs. It refuses loopback, private-network and cloud-metadata addresses, so an IRI that does not point at a public web resource will not resolve. The same rule holds for what it imports: an address in the source that is not `http`/`https` is never written into a record nor linked, and the report says *unsupported IRI scheme*.

!!! note "How the resource is fetched"
    The tool asks the IRI itself for RDF/XML, the way linked-data servers expect, and follows the server's redirects to the document. If the server answers with something else (a web page, or "not found"), the tool tries once more at the IRI with `.rdf` appended.

!!! note "Some sites do not allow automated access"
    Before fetching, Dédalo reads the site's `robots.txt` and follows it. If the site does not allow automated access to that address, the IRI is not fetched and the result says so (for example *The robots.txt of https://example.org does not allow automated access to this address*). Copy the values by hand, or ask the site.

!!! warning "A server that does not answer is out of service"
    If the remote server does not answer in time, drops the connection, reports an error of its own, or cannot deliver its `robots.txt`, the result says the server is out of service (for example *The server http://numismatics.org is not responding or is out of service. Contact its maintainer*). Nothing in Dédalo needs fixing: contact whoever maintains that server, or try again later.

!!! note "A resource of another kind imports nothing"
    The resource's RDF type decides where its data goes. If the External Ontology does not map that type into this record's section (for example, a Nomisma *mint* IRI on a coin-type record), nothing is written and the result says *Nothing imported: the external ontology maps no class of this record's section to the RDF type …*.

!!! note "At most three IRIs per run"
    One run imports at most three IRIs. The tool's own form sends one.

## Related

- **[Zotero import](using_import_zotero.md)** — imports a Zotero CSL JSON export file into Publications.
- **[CSV import](using_import_dedalo_csv.md)** — CSV import, including Dédalo's own `dedalo_raw` exports.
- **[MARC21 import](using_import_marc21.md)** — MARC21 library-catalogue import.
- **[Media file import](using_import_files.md)** — media ingest.
- **[Importing data](../importing_data.md)** — the import model, per-component conform contract and language handling.
- **[Developer reference](../../development/tools/reference/tool_import_rdf.md)** — the `get_rdf_data` action, its options and report.
