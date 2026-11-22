---
title: "A tool's `affected_tipos` honours its declared wildcard (`test*` = every element of that TLD) and regular-expression entries, and a tool restricted to a mode (`properties.mode`) only shows in that mode."
type: fixed
audience: developer
date: 2026-11-22
---
A tool registration may restrict where it is offered with `affected_tipos`: an exact tipo, a
`<tld>*` wildcard covering every element of a TLD, or a `/pattern/flags` regular expression. The
wildcard kept its `*` when compared, so it matched no element and a tool restricted by one
appeared nowhere. A malformed entry, or a regular expression with a flag other than `i`, `m`, `s`
or `u`, is reported once and matches nothing; the tool stays restricted to its valid entries. A
tool whose `properties.mode` names a mode now appears on the section toolbar only in that mode, as
it already did on component toolbars.
