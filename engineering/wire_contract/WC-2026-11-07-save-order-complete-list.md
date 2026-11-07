# WC-2026-11-07-save-order-complete-list — save_order refuses a sibling list that is not the parent's children

- **Date:** 2026-11-07 (TODO-077: the tree order control is enabled while a search is
  showing the tree; owner decision "server guard").
- **Decision:** DEC-12 (gated: `test/unit/ts_api_mutations_native.test.ts` — the
  missing / foreign / duplicated cases are refused with nothing written, the complete
  list is accepted).
- **Shape before (PHP and TS):** `dd_ts_api` `save_order` rewrote the order `1..n` from
  `source.ar_locators` exactly as sent (`sortChildren`), without re-reading the parent's
  sibling set. A list missing a sibling left that sibling's stored order untouched — a
  duplicate or out-of-sequence number; a foreign locator took a position. The client
  builds the list from the parent's `children_data.ar_children_data`, which can be
  incomplete: a node whose children were paged (300 per page), a list loaded before a
  later change, or a search tree whose ancestor path went through a term with two
  parents (`src/core/ts_object/search.ts` walks the flattened ancestor set as one chain).
- **Shape after (TS):** under the parent's node lock, before any write, the locator set
  must equal the parent's current children (`getChildren`, all pages): same members, same
  count, no duplicates. Otherwise `409 resource.conflict` with the public message
  `The order was not saved: the list of terms is out of date. Reload the tree and try
  again` and nothing is written. A parent with no children relation at all is unchanged
  (`sortChildren` still answers the section-map refusal, verbatim). The client
  (`ts_object.save_order`) now restores the local order and answers `false` when the
  request fails, and `render_order_form` then skips the DOM reshuffle.
- **Reason:** the order control is now live in search mode, where the sibling list is
  not always complete; the server is the only place that can know the full set, so it
  refuses instead of corrupting the order. Consequence, deliberate: a node with more
  than one page of children cannot be reordered from a partial page (it silently
  corrupted the order before).
- **Gate reconciliation:** no parity gate replays `save_order`
  (`test/parity/ts_mutations_differential.test.ts` names it only in its header); no
  fixture change, no re-harvest.
