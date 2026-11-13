---
title: Published RDF writes dates, years, integers and booleans in the standard XSD form, so the documents validate (a year -25 is written -0025).
type: fixed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-rdf-canonical-xsd-lexical
---
A typed value in a published RDF document (an `xsd:gYear` start date, an `xsd:date`, an
`xsd:integer`, an `xsd:boolean`) was written as the stored value's bare text: a year `-25` as
`-25`, which an RDF validator rejects (a year needs four digits). These values are now written in
the standard XSD form — `-0025`, `0010`, `2020-03-06`, `true` — so the documents validate and
linked-data consumers read the dates. Decimal weights were already correct. A value that cannot be
written in the standard form is reported in the run's errors, as a malformed decimal already was.

Republish the RDF elements to refresh the documents.

