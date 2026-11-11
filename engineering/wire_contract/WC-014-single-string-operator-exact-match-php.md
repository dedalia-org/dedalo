# WC-014 — single `=` string operator: exact match (PHP strips it and runs contains)

- **Date:** 2026-07-09 (owner-directed: "PHP is not a reference here — add
  operators in a better way").
- **Shape before (PHP):** the string search grammar has `==` (exact), `!=`,
  `-`, `!!`, `*` wildcards and `'quoted'` literals — but NO single `=`: a
  leading `=` falls through to the default case, which STRIPS `[+*=]` and runs
  contains. Typing `=Ea` therefore matched every value CONTAINING "ea"
  (1,250 hits on es1), so short names (`Ea`, `Ye`, `Ibi`) could never be
  reached in the autocomplete picker.
- **Shape after (TS):** `=word` is the single-char twin of `==` — exact,
  accent/case-insensitive equality (`builder_string.ts`; the shared tokenizer
  already glued `=` to its word, so `q_split` multi-word input fans out
  per-word). `=Ea` → exactly 1. `==`, `'quoted'`, wildcards, `-`, `!=`, `!!`,
  `*`/`!*` all keep their prior semantics (both engines agree there).
- **Why:** functionality — the picker needs a discoverable, single-keystroke
  exact operator; quoted literals work on both engines but nobody types them.
  Upstream PHP should adopt the same mapping.
- **Gate reconciliation:** no differential reds — no parity gate sends a
  single-`=` q (they would now deliberately diverge). TS ground truth pinned
  in `test/unit/search_string_equal_operator.test.ts` (exact vs contains
  cardinality on es1 `Ea`/`Ye`/`Ibi`, bare-`=` no-crash, `==`/literal
  equivalence).
- **Amended 2026-11-11 (owner-directed):** the case-insensitivity above was
  never implemented — `=` compared `f_unaccent(a) = f_unaccent(b)`, so `=vic`
  missed "Vic". `=` now compares `lower(f_unaccent(…))` on both sides. `==` and
  `'quoted'` stay accent-insensitive but CASE-SENSITIVE on purpose: the
  acquisition tools' find-or-create lookups (codes, lot URLs, identifiers) send
  `==` and must not merge case variants. The plain `!=` arm folds case too, so
  `!=x` stays the exact complement of `=x` (its wildcard arms already used
  `~*`). Folding is Postgres `lower()`: on a libc `C`-ctype database only Latin
  letters fold (Cyrillic/Greek do not) — the same limit as contains (`~*`).
  Gates: `test/unit/search_string_equal_operator.test.ts` (`'=' ignores letter
  case`, `'==' … stay CASE-SENSITIVE`, `'!=' is the complement of '='`) and
  `builder_shallow_snapshot.test.ts` (string `=`/`!=` must equal the snapshot
  with only that comparison rewritten).
