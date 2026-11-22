---
title: "A tool's `affected_tipos` honours its declared wildcard (`test*` = every element of that TLD) and regular-expression entries, and a tool restricted to a mode (`properties.mode`) only shows in that mode."
type: fixed
audience: developer
date: 2026-11-22
---
A tool registration may restrict where it is offered with `affected_tipos`: an exact tipo, a
`<tld>*` wildcard covering every element of a TLD, or a `/pattern/flags` regular expression. The
wildcard and the expression were read as literal tipos, so such a tool appeared nowhere. A
malformed entry is reported once and matches nothing; the tool stays restricted to its valid
entries. A tool whose `properties.mode` names a mode now appears on component toolbars only in
that mode.
