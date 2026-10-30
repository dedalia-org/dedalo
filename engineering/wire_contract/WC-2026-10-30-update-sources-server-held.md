# WC-2026-10-30-update-sources-server-held — the engine reads the master's manifest itself; masters are https

- **Date:** 2026-10-30 (update audit 2026-10-29, findings U-08, U-24, U-41; owner decisions D-4, D-8).
- **Decision:** DEC-12 (gated: `test/unit/ontology_update_source_native.test.ts`,
  `test/unit/ontology_source_map_native.test.ts`, `test/unit/version_contract_native.test.ts`,
  `test/unit/code_manifest_pin_native.test.ts`, `test/unit/update_server_https_native.test.ts`).
- **Shape before (TS):**
  1. `update_ontology` staged each file at the URL, with the typology, names and declared
     dependencies the browser posted (`options.files`); the master's ontology version was never
     compared with this install's.
  2. `update_code` verified the downloaded archive against the `file.sha256` the browser posted.
  3. `CODE_SERVERS` / `ONTOLOGY_SERVERS` accepted any scheme.
- **Shape after (TS):**
  1. `update_ontology` reads the selected master's manifest itself (a local master: its own
     export directory) and refuses with `update.refused` and `coordinates.rule`:
     `manifest_unreadable`; `ontology_version_unreadable`; `ontology_model_unknown` (the master is
     on a data model this code does not know); `ontology_model_mismatch`; `installed_model_mismatch`
     (the database is not on the code's model — "Update data" first); `installed_version_unreadable`;
     `file_not_in_manifest` (a TLD the manifest does not list, or listed at another URL — a local
     master compares by TLD); and, with several masters configured, `source_unassigned` |
     `source_ambiguous` | `source_mismatch` (D-8: each shared TLD has exactly one master, named in
     its `ONTOLOGY_SERVERS` entry's new optional `tlds` list). Each staged file is the MANIFEST's
     entry (URL, typology, names, dependencies); the browser's values for those are ignored.
  2. `update_code` asks the selected master for its manifest with the panel's own ask and refuses
     (`update.refused`) an archive the master does not offer at that URL, one whose `sha256` differs
     from the master's, or any request when the manifest cannot be read.
  3. A master that is not `https://` is dropped from `CODE_SERVERS` / `ONTOLOGY_SERVERS` at startup
     (one log line each) and refused again by both downloaders; plain http is admitted only on
     loopback, or anywhere under the development seam `DEDALO_UPDATE_HTTP_SOURCES_DEV`.
- **Reason:** the data that decides what is installed (an archive's digest, an ontology's files and
  model) must come from the master to the engine, never through a page (U-41); an ontology of
  another data model must never be imported (D-4); the shared `code` and the archives must not
  cross a network in clear (U-24).
- **Gate reconciliation:** TS-only; the frozen store holds no update-door interaction. No re-harvest.
