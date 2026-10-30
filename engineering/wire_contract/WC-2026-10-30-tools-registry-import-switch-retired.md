# WC-2026-10-30-tools-registry-import-switch-retired — TOOLS_ENABLE_REGISTRY_IMPORT is retired; the update run keeps each tool's stored ACTIVE value under the row lock

- **Date:** 2026-10-30 (update audit 2026-10-29, U-39; Phase 2 review #25). Extends WC-057.
- **Decision:** DEC-12 (gated: `test/unit/tools_register_write.test.ts` keepStoredActive case,
  `test/unit/update_run_ancillary_native.test.ts` tools case).
- **Shape before:** `config.tools.enableRegistryImport` (`TOOLS_ENABLE_REGISTRY_IMPORT`, default
  false) flipped `importTools()`'s default from dry-run to write. A PHP-coexistence switch: since the
  cutover every writer (installer, the Register tools widget's open branch) passed `dryRun:false`
  and ignored it; only the update run's ancillary phase consulted it, so an update re-registered
  tools only on installs that had set it. That phase read the admin's ACTIVE choices in one pass
  (a dry run) and wrote them in a second — a toggle committed between the passes was reverted.
- **Shape after (TS):**
  1. The key is gone from the catalog, `config.tools`, `install/sample.env` and
     `docs/config/config.md`. A leftover `.env` line configures nothing (no boot refusal: it is a
     deletion, not a rename — `RETIRED_ENV_KEYS` is rename-only).
  2. `importTools()` with no options is a dry run, always. Writers pass `dryRun:false`.
  3. The update run's ancillary `tools` reconciler ALWAYS writes, in ONE pass:
     `importTools({dryRun:false, keepStoredActive:true})`. For a registered tool,
     `writeRegistryRecord` locks the row (`readMatrixKeyForUpdate`) inside the write's own
     transaction and keeps the stored dd1354 value; a row without one takes the file's.
  4. Ancillary evidence `tools`: `{written, tools, invalid}` (`active_preserved` removed).
- **Client impact:** none — the Register tools widget's wire is unchanged (WC-057).
