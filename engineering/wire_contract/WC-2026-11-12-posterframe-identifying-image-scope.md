# WC-2026-11-12-posterframe-identifying-image-scope — tool_posterframe resolves identifying portals in virtual edit scope; create targets the request_config section

- **Date:** 2026-11-12 (RC-closure item T1-12, audit id OX7).
- **Decision:** PHP parity restored (no owner decision); DEC-12 (gate in the same change).

This is a RESTORATION of PHP behaviour, ledgered because the TS wire changes.

## Shape before (TS)

1. `get_ar_identifying_image` walked each referencing section's OWN ontology
   subtree. A record of a virtual section (`tch1`, `tch100`, `tch178`, `tch200`,
   `tch300`, `rsc197`, `navarra57`, `navarra60`, `numisdata713` in the vendored
   ontology) produced no descriptor — silently dropped from the selector. A
   virtual with an own identifying portal answered that portal.
2. `create_identifying_image` took the new record's section from the portal's
   ontology `relations` (first `section`-model relation). A portal declaring its
   target only in `request_config` (`isad66` on `isad1`) refused
   `tool.unsupported_target`.

## Shape after (TS = PHP)

a. The portal is the FIRST `component_portal` with `properties.identifying_image`
   in the section's VIRTUAL EDIT SCOPE (`editScopeComponents`,
   `src/core/relations/request_config/implicit.ts`; PHP
   `get_ar_children_tipo_by_model_name_in_section(…, resolve_virtual=true)`): the
   real section's subtree minus the subtrees named by the virtual's FIRST
   `exclude_elements`; a virtual's own children are not part of it. The
   descriptor keeps `section_tipo` = the referencing (virtual) section and its
   label, `component_portal` = the real portal tipo.
b. The create target = the first `sqo.section_tipo` of the portal's
   `request_config` in mode `edit` (`getElementTargetSectionTipos`; PHP
   `get_ar_target_section_tipo`) — the same law the portal save's
   target_sections membership validates. A config-less portal still resolves
   through the implicit relations walk. Empty → `tool.unsupported_target` (unchanged).
c. Descriptor shape and error codes are unchanged; only membership changes.

## Gate reconciliation

`test/unit/posterframe_identifying_image_native.test.ts` (situation `zzpf`). No
parity fixture covers tool_posterframe.
