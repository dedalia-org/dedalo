# WC-2026-11-17-tool-uca-maps-ts-only — `tool_uca_maps` is a TS-only tool (no PHP twin)

- **Date:** 2026-11-17 (the tool's PR; built on its branch from 2026-08-31).
- **Decision:** none new — the WC-019 / WC-062 / WC-2026-10-07-acquisition-tools-ts-only
  pattern for a wholly TS-native tool package.
- **Shape before (PHP):** nothing. The frozen PHP tree never shipped this tool, nor its
  previous version (`tool_leaflet_special_tools`, a contributed package that never reached
  this engine), so the PHP-imported `dd1324` registry the frozen store records has no row for
  it, and no oracle harvest saw its client files.
- **Shape after (TS):** a new tool package in the TS-owned `tools/` tree,
  `tools/tool_uca_maps/`: a component tool (`affected_models: ["component_geolocation"]`,
  `show_in_component`, active, not always_active, `isAvailable` on a geolocation caller), with
  a `server/` half of eighteen `record_tipo` actions (thirteen `readOnly`;
  `raster_download`, `vector_download`, `object_pdf_report` and `upload_vector_layer` consume
  the payload they were staged, `stage_external_image` writes). Its `dd1324` row is written by the TS *Register
  tools* door like any tool's (WC-2026-10-30-tools-registry-import-switch-retired). The
  component's own samples (`samples/context.json`, client and server twins) name it as the
  map's tool in place of the old ghost row.
- **Reason:** an additive feature with no PHP counterpart; there is no fossil wire shape to
  keep, only the frozen censuses' "every served client file / every user tool was harvested"
  assumption, which cannot hold for a tool PHP never shipped.
- **Gate reconciliation:** `test/parity/dedalo_files_differential.test.ts` filters the
  `/dedalo/tools/tool_uca_maps/` prefix from BOTH sides via `isTsOnlyEntry` (its client files
  are in the TS census and in no harvest), exactly as for the acquisition tools.
  `test/parity/user_tools_differential.test.ts` lists it in `POST_HARVEST_TS_TOOLS`, citing
  this id: filtered from the TS side and POSITIVELY asserted present there, so the filter
  cannot hide a tool that fell out of the registry. `tools_register_differential` needs no
  carve-out: the suite database registers the tool, and the gate's diff-free check covers it.
- **Fixture interaction (DEC-14b):** NO fixture edit, NO re-harvest. The frozen store stays
  the record of what PHP registered and served; the carve-out lives in the gates' TS-only
  sets, never in the fixture.
