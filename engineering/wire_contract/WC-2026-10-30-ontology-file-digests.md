# WC-2026-10-30-ontology-file-digests — ontology.json carries the sha256 of every served file; the stager verifies before extract

- **Date:** 2026-10-30 (update audit 2026-10-29, finding U-41 follow-up, design §4).
- **Decision:** DEC-12 (gated: `test/unit/ontology_file_digest_native.test.ts`; the export order in
  `test/unit/ontology_data_io.test.ts`).
- **Shape before (PHP, and TS until now):** `ontology.json` (served verbatim as
  `get_ontology_update_info` → `data.info`) named the active ontologies only; the
  `<tld>.copy.gz` / `matrix_dd.copy.gz` bytes a consumer fetched were never digest-checked (the code
  archive already was — `src/core/update/code_manifest_pin.ts`). The export wrote `ontology.json`
  BEFORE the COPY dumps.
- **Shape after (TS):**
  1. `ontology.json` gains ONE top-level key, `files_sha256`: a flat map
     `{"<name>.copy.gz": "<lowercase hex sha256>"}` covering every served `<name>.copy.gz` in the
     export directory (`matrix_dd.copy.gz` included), read from the bytes on disk. Everything else
     in the manifest (`info.*`, `files[]`) is unchanged. The `ontology18` record itself stays
     digest-free.
  2. `export_ontologies` writes `ontology.json` AFTER the per-TLD dumps and the private lists
     (`updateOntologyInfo` → dumps → private lists → `exportOntologyInfo` → LLM map), so the
     digests are of the final bytes. Until it lands, the previous manifest's digests no longer
     match: a consumer fetching mid-export is refused, never fed an unverified mix.
  3. The consumer parses `files_sha256` (a malformed map — non-hex value — refuses the manifest),
     carries each digest onto its file from the MANIFEST only (a client-posted `sha256` is
     dropped), and verifies the downloaded — or, for a local master, copied — file before it is
     reported ok / decompressed. Mismatch: the file is deleted, `{ok:false, msg: 'Error. Ontology
     file does not match the master manifest', errors: ['sha256 mismatch: <basename>']}`.
  4. A manifest WITHOUT `files_sha256` (an older master; the vendored
     `install/import/ontology/7.0/ontology.json`) is accepted as before, with one `console.warn`
     per update run naming the master and the unverified TLDs.
- **Reason:** the bytes imported into the ontology tables must be the bytes the master exported —
  a proxy, a cache, a half-written file or a tampered mirror must be refused before any
  destructive SQL (U-41: what decides what is installed comes from the master).
- **Gate reconciliation:** TS-only and additive; the frozen store holds no ontology-export or
  update-door interaction. No re-harvest.
