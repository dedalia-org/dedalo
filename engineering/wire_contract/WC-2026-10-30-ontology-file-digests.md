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
- **Addendum 2026-11-12 (T1-26 / S15 — the installer is a consumer too):** the installer's
  `stage_ontologies` (`src/core/install/ontology_install.ts`) obeys items 3–4 for EVERY file it
  stages — server (`downloadRemoteOntologyFile` with `expectedSha256`), local package and vendored
  release (`digestRefusal` after the copy), `matrix_dd.copy.gz` included — before the COPY shape
  check decompresses anything. Digests come from the source's own manifest only: the master's
  `info.files_sha256`, the local package's `ontology.json`, the release's vendored
  `install/import/ontology/<major.minor>/ontology.json` (read through the one leaf reader
  `src/core/ontology/ontology_file_digests.ts`; it DOES carry `files_sha256` — item 4's "the
  vendored ontology.json" no longer describes the shipped release). Mismatch refuses
  `install.step_failed` (`<name>: sha256 mismatch — the file is not the one its source manifest
  names; nothing was installed`), the file deleted, no `staged.json`. Absent digests: staged
  UNVERIFIED with one warning per origin (`staged.json.warnings`, `StageOntologiesResult.warnings`)
  naming every unverified file; a MALFORMED vendored map offers no vendored ontology (one catalog
  warning). The installer's internal types (`OntologyCatalogEntry`, `OntologyMatrixDd`,
  `OntologyInstallItem`) carry an optional `sha256`. No HTTP wire change. Gate:
  `test/unit/install_ontology_digest_native.test.ts`.
