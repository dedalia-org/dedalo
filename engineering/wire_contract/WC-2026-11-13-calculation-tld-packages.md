# WC-2026-11-13-calculation-tld-packages — `process.file` / `engine` are the calculation dispatch key; TLD packages; A1 + A2 closed

- **Date:** 2026-11-13.
- **Decision:** RC-closure T1-1 A1/A2, owner rulings 2026-11-13 (A1, A2, Q1–Q4
  of the TLD-widgets review): TLD-owned code lives in `src/tld/<tld>/`, reached
  through ONE registry; the ontology's `process.file` + `engine` select the
  table; PHP-era definitions are refused, never aliased. Amends
  WC-2026-11-12-calculation-widget-port §7 (OD-1 and OD-2 are CLOSED). DEC-12
  gates: `test/unit/calculation_widget_native.test.ts` (A1 / A2 pure + wire,
  C8 dispatch refusals), `test/unit/engine_install_tld_tripwire.test.ts`
  (legs 1–6), `test/unit/calculation_fn_registry_tripwire.test.ts` (full
  dispatch over both corpora; the shipped php-era bank).
- Code: `src/tld/{registry,types}.ts`, `src/tld/mdcat/{index,calculation}.ts`,
  `src/core/components/component_info/widgets/calculation/{calculation,functions,fn_kit}.ts`.
- Applies to every value of a `component_info` / `component_calculation`
  carrying a `calculation` widget: the section read (list + edit), the observer
  Time Machine rows, and the grid / export / diffusion values derived from them.

## Shape before (TS, WC-2026-11-12)

The block's `process.fn` alone selected a function from ONE flat registry of
nine (generic and mdcat mixed); `process.file` and `process.engine` were read
but ignored. Two interim refusals (`engine.uncovered_scope`): OD-1 — a
`final_total` whose caller was the install section PHP hard-coded, or whose
options declared `major_section_tipos`; OD-2 — a `calculate_import_major` /
`_minor` with no day value at all (absent / null / `[]`), while a day list
summing to 0 ran the formula and served its minimum (150000 / 900).

## Shape after (TS)

1. **`process.file` + `process.fn` are the dispatch key; `process.engine` must
   be `'ts'`.** `file` is matched against frozen tables, never resolved as a
   path: `/calculation/formulas.ts` → the generic table (`summarize`);
   `/<tld>/calculation/<module>.ts` → that TLD package's module
   (`src/tld/<tld>/`, registered once in `src/tld/registry.ts`). The mdcat
   package holds every fn the mdcat ontology files under
   `/mdcat/calculation/mdcat.*`: `calculate_period`, `calculate_import_major`,
   `calculate_import_minor`, `to_euros`, `range_to_days`,
   `days_correction_manually`, `subtract`, `final_total` (ruling Q3: an fn
   whose ontology file is under a TLD is that TLD's scope — `to_euros` moved
   out of the generic table).
2. **Refusals, `ontology.invalid_node`, coordinates `{ipo_key, fn?, file?,
   engine?}`, never an alias, never a silent `[]`:** a PHP-era block (`.php`
   file or `engine` other than `'ts'`, absent included); a `file` that is not
   `/<…>.ts`; an unknown package or module; an fn the SELECTED table does not
   hold — so a generic file naming a TLD fn (`/calculation/formulas.ts` +
   `final_total`) and a TLD file naming a generic fn (`…/mdcat.ts` +
   `summarize`) both refuse. A package fn may not shadow a generic name
   (tripwire leg 4 + a load-time assertion).
3. **A1 — `final_total`'s MAJOR branch** is taken when the caller section is
   the mdcat package's exported `MAJOR_GRANT_SECTION` (`mdcat2605`, the one
   install tipo in the engine tree, inside `src/tld/mdcat/`) AND `total_major`
   > 0; every other caller takes the minor branch; a non-zero `import_manual`
   wins over both. `options.major_section_tipos` is NOT read (it exists in no
   ontology; the interim refusal is deleted).
4. **A2 — `calculate_import_major` / `_minor` over ZERO days computes NO
   output.** Zero = no day value at all (absent / null / `[]`) OR a day list
   summing to 0, int or float. The fn answers `[]`, the widget emits no item
   for the block's outputs, the component renders empty; nothing throws, no
   minimum is served. On the wire a new grant with no day rows serves no
   `total` item for the import components (and `final_total` → 0 when nothing
   is paid). `[]` from a registered fn is a deliberate "no value computed"
   (documented on `CalculationFn`); definition errors THROW, and an fn the
   registries do not hold is refused before any fn runs — so `[]` is never an
   error signal.

## Reason

Nothing in the ontology can make the engine load code, and nothing in the
engine may silently stand in for a definition the ontology does not make: the
ontology names exactly the table and the fn it means, the engine runs exactly
that or says why not. The TLD-owned literal lives where its ownership is
mechanically checked (leg 2) instead of as a permanent exemption in the generic
engine.

## Gate reconciliation

- Shipped corpus: the vendored release still carries every calculation block
  in the PHP-era shape, so on this engine every shipped calculation refuses
  until the owner updates the v7 master ontology and the release is
  re-vendored. `calculation_fn_registry_tripwire` banks that honestly
  (`SHIPPED_PHP_ERA`, a live/exact file → fn histogram; read as `.ts` every
  block resolves — the mdcat/generic split is pinned against the corpus).
  `install/import/ontology/**` is NOT edited here.
- Suite twins: `src/core/test_data/test_tld_ontology.json` flipped to
  `.ts` / `engine:'ts'` at clone time (`policy.properties_rewrites`, owner
  authorised 2026-11-13 for this property only, no new node).
- `calculation_widget_native` legs replaced: the "summarized 0 runs the
  formula" and the OD-1 / OD-2 refusal legs → A1 / A2 legs; six dispatch
  refusal nodes added.

## Not changed

- Nothing is stored (DEC-06); no repair step. The client twin
  `client/dedalo/core/widgets/mdcat/calculation/mdcat.js` is unreferenced dead
  code (no `client/` consumer imports it) and returns 0 on zero days where the
  server now serves no item — ledgered, out of scope.
- The rest of WC-2026-11-12 (summarize semantics, relation / info inputs,
  scope refusals) stands.
