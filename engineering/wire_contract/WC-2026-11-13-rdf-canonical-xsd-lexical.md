# WC-2026-11-13-rdf-canonical-xsd-lexical — rdf typed literals are written in their CANONICAL XSD lexical form (gYear `-25` → `-0025`)

- **Date:** 2026-11-13.
- **Decision:** owner ruling C12 (`T1_owner_decisions.md`, 2026-11-13; item T1-4 "XSD lexical
  forms"): canonical — "published RDF must validate". Closes item 12 of
  `WC-2026-11-12-rdf-graph-interpretation` (addendum there). DEC-12 gates:
  `test/unit/rdf_xml_serialiser.test.ts` (the hermetic matrix per datatype + the pinned v5 type
  document), `test/unit/diffusion_rdf_graph_native.test.ts` (the pinned zzdif document: start/end
  years `-0025` / `0010`).
- Code: `src/diffusion/resolve/rdf_graph_ir.ts` `typedLiteral` (`CANONICAL_XSD`,
  `canonicalLexical`).

## Shape before (PHP = EasyRdf 1.19 Literal::create; TS until today)

Only `xsd:decimal` was canonicalised (`Literal\Decimal`: `1` → `1.0`, `0.830` → `0.83`); every
other datatype wrote the PHP `(string)` cast of the stored value: a component_date year `-25`
published `<nmo:hasStartDate rdf:datatype="…#gYear">-25</nmo:hasStartDate>`, a year `10` as `10`,
a PHP boolean as `1` / `''`. An XSD validator (and every consumer that parses `xsd:gYear`) rejects
these — a gYear is `-?\d{4,}` with an optional timezone.

## Shape after (TS)

`typedLiteral(value, phpType, datatypeUri)` canonicalises these XSD datatypes, by datatype:

| datatype | canonical lexical | examples |
|---|---|---|
| `xsd:gYear` | sign (`-` only) + at least four digits, optional timezone kept | `-25` → `-0025`, `10` → `0010`, `+0325` → `0325`, `12345` kept |
| `xsd:gYearMonth` | `yyyy-mm` (month 01-12) | `-25-3` → `-0025-03` |
| `xsd:date` | `yyyy-mm-dd` (the month's own day range, proleptic Gregorian), timezone kept | `325-1-5` → `0325-01-05` |
| `xsd:dateTime` | `yyyy-mm-ddThh:mm:ss[.f…][tz]`, fields zero-padded, fraction's trailing zeros cut | `2020-3-6T7:5:9.500Z` → `2020-03-06T07:05:09.5Z` |
| `xsd:integer` | `+` and leading zeros stripped, `-0` → `0`; a non-integer number refused | `+007` → `7` |
| `xsd:boolean` | `true` / `false` (from a boolean, `1`/`0`, or the words, case-insensitive) | `true`, `1` → `true` |
| `xsd:decimal` | unchanged (EasyRdf canonicalisation) | `1` → `1.0` |

An unparseable value THROWS `RdfLiteralError` (`xsd:<type> literal: '<value>' doesn't look like a
valid <type>`) — the property's run error line, as the decimal refusal already was; the record's
other properties still publish. Datatypes outside the table (`xsd:double`, `xsd:string`, custom
URIs) keep the PHP cast exactly as before.

## Reason

A published linked-data document that does not validate is not interoperable: Nomisma's own
consumers parse `nmo:hasStartDate` as `xsd:gYear`. The stored component_date value is correct
(`year: -25`); only its serialisation was wrong, in both PHP engines. Repair on an install:
republish the rdf elements (deterministic file names overwrite the previous documents).

## Gate reconciliation

No frozen fixture holds an rdf document (none was harvested). `rdf_xml_serialiser` pinned the v5
type document with `-25` and `diffusion_rdf_graph_native` with `-25` / `10`: both pins flip to
the canonical form in this change (a contract edit, this entry). The import reader
(`rdf_import_plan`) already read canonical years from real OCRE documents — unchanged.
