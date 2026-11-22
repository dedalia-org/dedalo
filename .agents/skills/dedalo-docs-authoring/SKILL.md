---
name: dedalo-docs-authoring
description: >-
  Writing and correcting the Dédalo v7 manual in docs/ — above all the LAW THAT EVERY ONTOLOGY TIPO IN AN EXAMPLE MUST BE A REAL, VERIFIED NODE (never lit5/unc1-style placeholders, never a real tipo with the wrong model), plus the mechanical gates (docs_current_engine_tripwire: PHP-free prose, resolvable internal links, no rewrite/ paths) and the storage-shape facts examples keep getting wrong (relation vs relations, keyed-by-tipo vs flat array). Use when adding or editing ANY file under docs/, when a doc example is reported as wrong or confusing, when docs_current_engine_tripwire fails, when documenting a component/tool/area, or when copying a config example out of the docs into an ontology. Canon: docs/development/documentation_style_guide.md.
---

# Authoring Dédalo v7 docs

`docs/` is the **user- and developer-facing manual of the CURRENT engine** (TS/Bun).
Prose canon: `docs/development/documentation_style_guide.md` — read it for voice,
terminology and heading structure. This skill covers the part that keeps biting:
**examples that are not real**.

## THE LAW: every tipo in an example is a real, verified node

Dédalo is ontology-driven. A `tipo` is not a placeholder name — it is an
**address** in `dd_ontology`, and readers **copy examples straight into their
ontology**. So an invented tipo is not a harmless illustration; it is a config
that cannot work, published as if it did.

Two failure modes, both found live in `docs/core/components/component_dataframe.md`
(2026-07-31), both of which cost a user real debugging time:

1. **Invented tipos.** `lit5`, `lit5_section`, `lit5_df`, `unc1`, `unc_label`,
   `unc_rating`. Beyond being unusable, they are **not even in Dédalo's tipo
   format** (`<model-prefix><n>` — `oh16`, `rsc1246`, `numisdata1447`,
   `dd560`), so they read as a different system's identifiers and actively
   confuse.
2. **Real tipos with the WRONG model** — worse, because they look verifiable.
   That page called `oh22` a `component_input_text` (it is a
   `component_filter`), `oh57` a frame target *section* (it is a
   `component_date`), and `oh58` a `component_input_text` (it is a
   `section_list`).

### The rule

> Never invent a tipo. Take examples from the real ontology, and verify the
> model of every tipo you name before you publish it.

Verification is one query — run it over every tipo the page mentions, in code
font AND in JSON. Point `psql` at the app DB named in `../private/.env` (never a
hardcoded role/DB) and run **read-only** queries only:

```bash
# connection = the app DB in ../private/.env
env_val() { grep "^$1=" ../private/.env | cut -d= -f2- | tr -d '"'; }
export PGHOST="$(env_val DEDALO_HOSTNAME_CONN)" PGPORT="$(env_val DEDALO_DB_PORT_CONN)" \
  PGUSER="$(env_val DEDALO_USERNAME_CONN)" PGDATABASE="$(env_val DEDALO_DATABASE_CONN)" \
  PGPASSWORD="$(env_val DEDALO_PASSWORD_CONN)"

# every tipo referenced in a doc page, checked against the ontology
grep -o '`[a-z]\{2,12\}[0-9]\{1,5\}`' docs/<page>.md | tr -d '`' | sort -u > /tmp/t.txt
grep -o '"[a-z]\{2,12\}[0-9]\{1,5\}"' docs/<page>.md | tr -d '"' | sort -u >> /tmp/t.txt
sort -u /tmp/t.txt -o /tmp/t.txt
psql -At -c "
WITH t(tipo) AS (VALUES $(sed "s/.*/('&')/" /tmp/t.txt | paste -sd, -))
SELECT t.tipo||' -> '||coalesce(o.model,'*** NOT IN ONTOLOGY ***')
FROM t LEFT JOIN dd_ontology o USING (tipo) ORDER BY 1;"
```

Then read the output against the prose: a tipo that *exists* is not enough —
the **model must match what the sentence claims it is**.

Pull the example itself from the source of truth rather than retyping it:

```bash
psql -At -c "SELECT jsonb_pretty(properties) FROM dd_ontology WHERE tipo='numisdata1447';"
```

If a config genuinely has no live instance, say so in the prose ("no live
instance on this install; shape only") instead of minting fake tipos — an
honest gap beats a fictional example.

### Naming the install

The corpus tipos differ per install. The install-independent choice is the
generic `test` TLD the repo itself ships (`test3`, …) or core `dd`/`rsc`
nodes. When an example needs a corpus node (`numisdata…`, `oh…`), *say which
install* it comes from, so a reader on another install knows why it is absent.

## The other thing examples get wrong: storage shape

Doc examples repeatedly showed relation data as:

```json
{ "relations": [ {…locator…} ] }          // WRONG on both counts
```

The truth, verifiable on any row:

```json
{ "relation": { "<component_tipo>": [ {…locator…} ] } }
```

`relation` is **singular**, and it is a JSONB **object keyed by component
tipo**, not a flat array. Literal values live in `string` (also keyed by tipo).
Check before writing a storage example:

```bash
psql -At -c "SELECT section_id, jsonb_pretty(relation) FROM matrix
  WHERE section_tipo='<section_tipo>' AND relation <> '{}'::jsonb LIMIT 1;"
```

## Document what is WIRED, and mark what is inert

An ontology key that exists in real nodes is not proof it does anything.
`hard_delete` sits on 59 dataframe slot nodes and **nothing reads it**. v6
commented its reader out ON PURPOSE ("time machine needs to show the previous
state, so, never deletes it"), and the page must say it is inert, or a reader
copying it expects a delete. The cautionary tale: on 2026-09-06 it was taken
for a forgotten promise, wired as a hard delete, and removed real frame targets
until 2026-09-29 (WC-2026-09-29-dataframe-hard-delete-retired). A commented-out
branch is not proof of neglect — read the comment beside it before calling
a key dead or reviving it.

Before documenting a property as having an effect:

```bash
grep -rn "<property_name>" src/ client/     # who actually reads it?
psql -At -c "SELECT count(*) FROM dd_ontology WHERE properties ? '<property_name>';"
```

Zero readers ⇒ document it as **INERT** with a warning admonition. Zero
ontology users but a real reader ⇒ fine, say it is unused today.

## Mechanical gates (run these; they are fast)

`test/unit/docs_current_engine_tripwire.test.ts` enforces four things:

| gate | rule |
|---|---|
| PHP-free prose | No PHP reference in `docs/` outside the reason-stamped allowlist. PHP is allowed ONLY as migrate-from/history, and the allowlist is exact — quiet additions fail. |
| links resolve | Every internal link must resolve to a real file **inside** `docs/`. |
| no escaping links | Repo paths outside `docs/` (`engineering/`, `src/`, `scripts/`) are named in `code font` as PLAIN TEXT, **never linked** — `engineering/` keeps its PHP references, so linking there re-imports PHP through the back door. |
| no `rewrite/` tokens | `rewrite/` is gitignored and absent from a clone; a doc must never name a path under it. |

```bash
bun test test/unit/docs_current_engine_tripwire.test.ts
bun run scripts/verify.ts     # includes the above
```

Two traps worth naming, both hit in one session:

- Writing "PHP" in an explanatory aside (e.g. citing `get_list_of_values`) fails
  the first gate. Describe the *behaviour* instead of citing the PHP symbol.
- Linking a component_autocomplete.md page — it does not exist. `component_autocomplete`
  is an alias of `component_portal`; check `docs/core/components/` before linking
  a component page.

`mkdocs build --strict` is the fuller check but needs `pymdownx`, which is not
installed in this environment — the tripwire is the gate that must pass.

## Admonitions

Use the set already in use (`note`, `warning`, `info`, `tip`, `danger` — most to
least frequent). Reserve `danger` for "this silently produces a broken config".

## Checklist before finishing a docs edit

- [ ] Every tipo verified to EXIST **and** to have the model the prose claims.
- [ ] Examples pulled from the ontology / a real row (read-only), not retyped from memory.
- [ ] Storage shapes use `relation` (object keyed by tipo), `string` for literals.
- [ ] Properties documented as effective have a real reader in `src/`; inert keys marked.
- [ ] `bun test test/unit/docs_current_engine_tripwire.test.ts` green.
- [ ] No new PHP reference, no link outside `docs/`, no `rewrite/` path.
- [ ] Did NOT "fix" a working example while correcting a broken one — re-read the
      diff and confirm each change is required (a session correcting a missing
      `mode` also changed two `view` values that were correct).
