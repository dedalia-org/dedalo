# WC-2026-08-31-client-reads-three-fields-the-engine-never-emits — a narrowing that had no ledger line

- **Date:** 2026-08-31, adopted with the change that closes audit row P2-26
  (finding DEAD-05).
- **Decision:** DEC-12 (the invariant lands with its gate:
  `test/unit/wire_field_agreement_tripwire.test.ts`). The divergence is a
  PHP-era emission the TS rewrite DROPPED — a scope narrowing, which the
  project's law forbids doing silently. This entry is the ledger line it never
  got.

## The measurement

`grep -rn transliterate src/ --include=*.ts` returns nothing outside an
unrelated media-provenance comment. Censusing every `self.data.<field>` the
browser reads against everything `src/` so much as mentions, three fields come
back (measured 2026-08-31, 34 distinct field reads scanned):

| field | client modules reading it | what is lost |
|---|---|---|
| `transliterate_value` | 4 | the sibling-language value hint — a translation aid — never renders, and the cross-language id share is dead code |
| `q_lang` | 1 | a search-language annotation the client is prepared to show and never receives |
| `permissions_indexation` | 1 | an indexation-permission hint the client branches on and never receives |

`transliterate_value` is the consequential one. The parity ledger test lists it
among the PHP data-item fields and it sits in that test's known-fields
allowlist, so the field is not even WARNED about: the one place that could have
noticed was configured not to.

## Why this is not "delete the readers"

Two of the three are single-module hints and could go either way. The first is
not: `transliterate_value` is a translation aid in a MULTILINGUAL heritage
system, and the cross-language id share it feeds is the guard that keeps an
empty-but-existing IRI entry out of the clear-all path (audit P0-8 / DATA-06).
Deleting the readers would remove a curator-facing feature and a safety guard on
the strength of "the server does not currently send it", which is the narrowing
restated rather than decided.

Emitting it is engine work with parity implications and belongs to whoever owns
the component_input_text / component_iri read path.

## What was decided

The gap is now DECLARED and MECHANICAL rather than silent:

- the census is a registered tripwire, TOTAL over the client's data-item field
  reads, with these three enumerated and reasoned;
- the list is SHRINK-ONLY. A fourth field the client reads and the engine never
  emits is a new narrowing and reds the gate; removing one — by emitting it, or
  by deciding to delete its readers — is the burn-down.

The client's own source already carries two `(!) BUG FLAG` comments about
`transliterate_value` being consumed as an Array where a string is expected.
Those stay accurate and are not this entry's subject: a field nothing emits
cannot have a shape bug in production, and fixing the shape before deciding
whether to emit it would be work aimed at code that never runs.

## Closure — `transliterate_value` (2026-10-31)

`transliterate_value` is EMITTED again: the `lang_versions` emit hook
(`src/core/components/lang_versions_emit.ts`, declared by component_input_text
and component_iri) puts it on every transliterable literal item — every
component_iri, and a component_input_text whose ontology says
`with_lang_versions`. Shape, doors and gates:
WC-2026-10-31-transliterate-value-emitted. The tripwire moved the field from
`NOT_EMITTED` to `CLOSED`, which pins the closure the other way (still read,
still ASSIGNED in `src/`, still ledgered). Two fields remain open: `q_lang`,
`permissions_indexation`.

The `(!) BUG FLAG` noted above is resolved on the client side: the list and mini
views now read `transliterate_value[0].value` (the Array shape the engine
emits). One TS-era client defect surfaced by the emission was fixed with it:
component_iri's `render_transliterate_value` read `self.context.render_class`
in a module-level function with no `self` in scope (a TypeError the moment an
IRI counterpart rendered); the component context is now a parameter.
