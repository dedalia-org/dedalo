# WC-2026-11-12-marc21-config-map-and-transforms — tool_import_marc21 reads its map on the server and applies every mapping rule

- **Date:** 2026-11-12.
- **Decision:** RC-closure T1-6 / audit OX2 (owner authorised Tier 1
  implementation 2026-11-12). DEC-12 gates: `test/unit/tool_import_marc21.test.ts`
  (the "server config + ported value semantics (T1-6)" and "parseMarcConfig"
  blocks), `test/unit/marc21_map.test.ts` (pure extraction + transforms).
- Code: `tools/tool_import_marc21/server/index.ts` (`parseMarcConfig`,
  `importMarc21Targets`), `src/core/tools/marc21.ts` (`extractMarcValue`,
  `transformMarcValue`, `applyMarcMap`), `src/core/tools/import_form_values.ts`
  (the Values form, shared with tool_import_files), `src/core/tools/import_data.ts`
  + `import_execute.ts` (`MappedField.literal` / `.refusal`).

## Shape before (TS)

- `map`/`main` were read from the CLIENT-posted `tool_config`. The real client
  posts the ontology `properties.tool_config[tool]`, which holds only `ddo_map`,
  so every real import answered `Missing marc21_map`. Where a map was posted it
  was a client-chosen write map.
- Every occurrence of a tag became a separate item; an array `field`
  (`field_multiple`, the shipped "Indexations" rule) was silently DROPPED; no
  transform ran (`partial_left_content`, `date_format`, `dd_data_map`,
  `dd_action`, trailing-punctuation strip); a conditional with no matching
  occurrence wrote nothing.
- Values went through the CSV cell grammar: `"[1987]"` was JSON-decoded and
  stored as the number 1987; a raw `"spa"` reached the relation conform as a
  record id and was refused.
- The Values form (`input_component`) was never applied, yet WC-079's
  consume-clear wiped it after the run.

## Shape after (TS) = v6 tool_import_marc21

Frozen v7 is NOT the reference here: its `prepare_import_context` reads
`$config->config->main` off the ARRAY `tool_common::get_config` returns, so it
imported nothing. v6 (`class.tool_import_marc21.php :21-330`) is.

- **Config is the server's:** `getToolConfig('tool_import_marc21')` — the Tools
  configuration (dd996) over the register default (dd1633), per key. The client
  `tool_config` is read for `ddo_map` only; a posted `map`/`main` is ignored.
  The `targets` gate authorizes the caller pair + the Values fields; every
  mapped field (and `dd_action` companion) is re-authorized per record by the
  executor's write door, so a component the caller may not write is IGNORED.
- **Extraction** (PHP get_value / get_field / extract_marc21_value): the FIRST
  occurrence of a tag; `field_multiple` joins every occurrence of every listed
  tag with `row_separator` (default `'. '`); `marc21_conditional` reads the first
  occurrence whose guard matches, else falls back to the unconditional first
  occurrence.
- **Transforms**, PHP order: trim; strip trailing ` \t,:.`; `partial_left_content`
  (first run of digits); `date_format:'year'` → `[{start:{year}}]`;
  `dd_data_map[code]` → the mapped data. `dd_action` writes its companions right
  after an entry that yielded a value. Entries save in map order, so a tipo
  bound twice keeps the last non-empty one; a text the strip empties (`':'`,
  `'.'`) yields nothing — no field, no companion.
- **Literal text:** a transformed text value is conformed as TEXT, never
  JSON-decoded (`MappedField.literal`) and never refused by the CSV-cell
  bracket guard (`'["Cartas"] : selección'` is stored as-is, as PHP did);
  structured outputs (dates, locators,
  Values items) are JSON and pass the normal conform validation.
- **Values form:** every non-empty `input_component` field is applied to every
  imported record, after its mapped fields (a Values value wins), inside that
  record's transaction, per language by each item's `lang`.

## Divergences from v6 (deliberate)

1. `"0"` is a value (PHP `empty()` skipped it); only `''` is empty.
2. A `date_format:'year'` value with no year > 0 is REFUSED per field (PHP
   stored an empty date); a `dd_data_map` miss is REFUSED per field naming the
   code (PHP wrote the raw code, which the relation conform refuses anyway).
   Neither fires `dd_action`.
3. The `name:'id'` entry is written trimmed only, never punctuation-stripped:
   it is the value the code lookup searches, and a stored `B123` vs a searched
   `B123.` would duplicate the record on every re-import (DATA-08 upsert).
4. Control fields (00X) are readable (PHP read `''` — File_MARC control fields
   carry no subfields).
5. Unknown map keys, a malformed field/transform, `date_format` + `dd_data_map`
   on one entry, a conditional over `field_multiple` — the run is REFUSED
   (`request.invalid_options`) naming the entry. PHP ignored them. `skip_on_empty`
   is accepted and inert (unreachable in PHP).
6. A Values field of another section than the import section is REFUSED before
   any write (PHP wrote that section's record of the same number).
7. `marc21_conditional` fallback (D1) and first-occurrence (D2) follow PHP; both
   are laid out to the owner as override points (T1-6 plan §7).

## Reason

The import refused on every real install; where it ran it stored raw MARC
punctuation, numbers for bracketed dates and no dates, languages or material
types at all, and threw away the Values the operator typed.

## Gate reconciliation

No parity gate replays this tool (write path). The DEC-14b twins are the
native gates named above. No fixture changes.

## Addendum 2026-11-13 — D1 and D2 RULED (owner C16, C17)

- **C16 — `marc21_conditional` with no matching occurrence → NO value.** Item 7
  above ("fallback follows PHP") is reversed: `extractMarcValue` answers `''`
  when the guard is present and no occurrence passes it, so nothing is written
  for that field (no `failed` line either — an absent copy is not an error).
  PHP's `?? get_value` fallback read the FIRST occurrence regardless of its
  guard, i.e. imported another library's copy data (a 945 holdings line of a
  different `$j`) as this library's. Gates: `marc21_map.test.ts` "conditional:
  the guarded occurrence, else NO value", `tool_import_marc21.test.ts` G10
  (`g10f` → no value; was `'Shelf C'`).
- **C17 — `occurrences: 'all'` (opt-in).** A new map-entry key, accepted only
  as the string `"all"`: without `field_multiple`, every occurrence of the ONE
  tag is read, the non-empty texts joined by `row_separator` (default `'. '`),
  before the trailing-punctuation strip. The default stays the first occurrence
  (D2 as shipped). Refused: any other value, and the pair with
  `marc21_conditional` (which names one occurrence). `MAP_ENTRY_KEYS` grows by
  `occurrences`; `main.field_to_section_id` shares the spec parser and so
  accepts it too. Gates: `marc21_map.test.ts` "occurrences:'all' joins every
  occurrence", `tool_import_marc21.test.ts` G3b (G3 first-only unchanged) and
  "occurrences accepts only 'all'…".
- Docs: `docs/development/tools/reference/tool_import_marc21.md` (rule table +
  example). Fragment `marc21-conditional-no-fallback-and-occurrences`.


## Addendum 2026-11-22 — T2-IMP-1: PHP's `*/<code>` lookup arm is NOT ported (owner FYI-6)

- **PHP:** `get_section_id_from_code` (class.tool_import_marc21.php :1202) searched the code component
  with an `$or` of TWO leaves — `=<code>` and `*/<code>` (a suffix wildcard: any stored value ending
  in `/<code>`) — `limit 1`, first hit wins.
- **TS (unchanged):** the MARC door's lookup (`import_code_lookup.ts` `resolveMappedCodes`) is the
  exact-identity law only: the search narrows, the trimmed byte comparison decides. A stored
  `<prefix>/<code>` (e.g. `https://catalog.test/record/<code>`) names NO record for `<code>`; the
  run creates its own record.
- **Reason (structural):** a suffix wildcard matches a look-alike (`X/123` for code `123`) — the
  defect the exact-identity law (DATA-08) closed. The arm was a copy of the Zotero lookup, whose
  codes are URL-shaped; a MARC control number has no URL form, and Zotero's own leg was ported as an
  EXACT match (T1-7). A port would overwrite whichever record merely ends in the number.
- **Gate:** `test/unit/marc_identity_native.test.ts` "a stored <prefix>/<code> is not matched by
  <code>…" (door end to end: created 1, updated 0, holder's title and code untouched). Mutation: the
  PHP `$or` suffix leaf + suffix byte accept in the lookup → red (updated, not created). Write path;
  no fixture.
