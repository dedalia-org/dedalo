# WC-2026-08-02-tool-string-lang-fallback — tool label/description resolve down a DECLARED lang chain, not `items[0]`

- **Date:** 2026-08-02 (reported as "the tool indexation label is wrong": an
  lg-spa install rendered the `tool_indexation` header with a GERMAN
  description).
- **Decision:** none standing — this is the fix for the defect that the
  behaviour, faithfully ported, was itself the bug.
- **Shape before (PHP):** `buildToolElementContext` / `create_tool_simple_context`
  resolved a tool's label (dd799) and description (dd612) by taking the entry
  whose `lang` matched the application lang, and otherwise `items[0]` — the
  first entry in the STORED array. Storage sorts those arrays by lang code, so
  the fallback language was an artefact of the alphabet crossed with whichever
  translations happened to exist: `tool_indexation`'s dd612 had
  `lg-deu, lg-ell, lg-eng, lg-nep` and no `lg-spa`, so an lg-spa install was
  served German; had German been absent it would have served Greek. The same
  missing translation resolved to a different language per tool.
- **Shape after (TS):** both resolve through
  `src/core/resolve/lang_fallback.ts` — requested lang → its declared linguistic
  alias (`lang_alias.translationLangOf`) → the INSTALL's default application lang
  (`DEDALO_APPLICATION_LANGS_DEFAULT`) → `MASTER_SOURCE_LANG` (the lang program
  strings are authored in) → the first non-empty entry. The last step is kept so
  a string translated into NO chain lang still shows something rather than
  vanishing, but it is now reached only when every meaningful candidate missed.
  The chain is the one the global UI-label catalog already uses
  (`src/core/labels/catalog.ts`), so the two label stores degrade alike. An
  untranslated label still falls back to the tool NAME, and an absent description
  key is still omitted from the context — neither of those changed.
  Unchanged too: the SINGLE-LANG contract of the dd1372 tool labels (no
  substitution there — see TOOLS_SPEC "Tool labels").
- **Reason:** the client renders whatever string the context carries. Serving a
  language the user did not ask for, chosen by storage order, is not a fallback —
  it is a lottery, and it reads to the user as a broken label.
- **Gate reconciliation:** new unit gate
  `test/unit/tool_string_lang_fallback.test.ts` (seeds its own scratch tool row
  with a `lg-aaa` TRAP entry that sorts before every other seeded lang, so the
  old `items[0]` rule fails it loudly; install-dependent values are read from
  config so it holds on any install). **No re-harvest needed:** the frozen
  fixtures only pin tools whose strings exist in the requested lang —
  `tool_element_context_differential` covers tool_export / tool_lang /
  tool_time_machine (all translated), and `user_tools_differential` pins labels
  only, where the sole untranslated cases (`tool_dev_template`, `tool_qr`) carry
  a single `lg-eng` entry that both the old rule and the new chain resolve
  identically. The chain therefore changes no frozen byte.

## Data note (same day, not part of the divergence)

The code change makes the fallback deterministic; it does not invent
translations. The missing `lg-spa` descriptions were added to the `register.json`
seeds of the eleven tools that lacked them (dd_label, dev_template, diffusion,
import_rdf, indexation, lang_multi, pdf_extractor, posterframe, qr,
update_cache, user_admin) and landed in `matrix_tools`. `tool_error_report`,
`tool_identify` and `tool_sitebuilder` have no description in ANY lang — left
alone, since adding one is new content, not a fix. `tool_dev_template`'s missing
`lg-spa` LABEL was left alone deliberately: `user_tools_differential` pins it as
"Development Template", so translating it is a fixture-visible change and belongs
to whoever re-cuts that gate.

## Addendum 2026-11-22 — the dd1372 tool labels take the declared alias leg (T2 batch B5: O11-3)

The SINGLE-LANG contract of the dd1372 tool labels (`buildToolElementContext`,
`toolLabelsInLang`) gains ONE leg: per key the requested lang lacks, the entry of its
declared linguistic alias (`lang_alias.translationLangOf`, `DEDALO_LANG_EQUIVALENCES` —
`lg-vlca` reads `lg-cat`), served with its stored `lang`. PHP did the same
(`lang::get_label_lang`) and then fell back to the first stored entry; that last step stays
retired. The alias is the same language under another name, so the client's
name-match-is-right-language reading (`get_tool_label`) holds. Directional: `lg-cat` never
reads `lg-vlca`. The frozen `tool_element_context_differential` requests `lg-spa` only (no
alias) — unchanged, no re-harvest. Gate: `test/unit/tool_context_labels_lang.test.ts` (alias
leg: own entry first, the rest from Catalan, directional).
