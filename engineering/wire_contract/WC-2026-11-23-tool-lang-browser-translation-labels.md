# WC-2026-11-23-tool-lang-browser-translation-labels — the tool_lang context carries the browser-translation labels the PHP oracle never had

- **Date:** 2026-11-23, at the merge of t2/a102 (A1-02, the in-browser translation
  pipeline) into master. The labels landed on that branch from 2026-11-22
  (`1dced276f3` onward); the branch's own gates did not run the parity tier, so the
  ledger line was owed at the merge and is written there.
- **Decision:** DEC-12 (the gate exists — `test/parity/tool_element_context_differential.test.ts`
  caught it through `parity_baseline_tripwire`: one NEW red). DELIBERATE: new UI copy
  for a translation path the PHP engine did not have.

## Shape before (PHP)

`get_element_context` for `tool_lang` returned the label set of the final harvest: no
label of the in-browser translation (its engines, model choice, per-block refusals,
save warnings, mark repair).

## Shape after (TS)

`tools/tool_lang/register.json` declares 40 more label names, each in all 11 shipped
languages: the per-block refusal reasons (`block_added_markup`, `block_added_mark`,
`block_added_emphasis`, `block_lost_text`, `block_repetition`, `block_truncated`), the
save-with-warnings report (`sentences_short`, `emphasis_moved`, `emphasis_lost`,
`translation_review_needed`, `translation_saved_with_warnings`, `translation_degenerate`),
mark repair (`marks_unplaced`, `marks_invented`, `marks_repositioned`, `marks_reordered`,
`marks_removed_invalid`, `marks_outside_text`, `tags_out_of_order`, `tags_crossed`), the
refusal/failure lines (`nothing_saved`, `translation_retry`, `translation_incomplete`,
`translation_save_failed`, `translation_empty_result`, `translation_token_collision`,
`translation_no_model`, `translation_lang_unmapped`, `gpu_unavailable`) and the model
picker (`configuration`, `engine_qwen`, `engine_translategemma`, `engine_nllb`,
`engine_madlad`, `engine_opus`, `translation_model`, `model_quality`, `model_quality_q4`,
`model_quality_q8`, `requires_webgpu_hint`). Additive only: no frozen label changed or
went.

## Reason

The client renders every refusal, warning and model choice of the browser translation
from these labels; without them the operator sees nothing, or an untranslated key, at
the moment a translation was refused or saved with text that needs review.

## Gate reconciliation

`tool_element_context_differential` (tool_lang branch) removes EXACTLY these names from
the TS labels before the compare, the tool_export / tool_time_machine law: every name
must be a TS label (a dropped or renamed one is red), and the frozen side must carry
none of them. No fixture edit and no re-harvest: the gate transforms the TS response
before diffing (the WC-001 pattern). A suite DB whose tools were registered before the
labels landed is red until `bun run test:db:setup`.
