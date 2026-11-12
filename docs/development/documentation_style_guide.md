# Documentation style guide

> See also: [Development](index.md) · [Code documentation standard](code_documentation_standard.md) · [Documentation hub](../index.md)

This guide defines how to write the **prose documentation** under `docs/` — the MkDocs site you
are reading now. Its goal is a single, coherent voice across every page: uniform structure,
consistent terminology, accurate examples, and clear, native English.

> Scope: the Markdown files under `docs/` only. For doc-blocks and inline comments inside Dédalo's
> TS/JS **source**, see the separate [code documentation standard](code_documentation_standard.md).

## Guiding principles

1. **Accuracy first.** A doc that is wrong is worse than no doc. Never invent a method, property,
   tipo, flag or behavior. If you cannot verify a claim against the code, flag it — do not guess.
2. **Explain the *why*.** State the contract, the edge cases and the consequences of getting it
   wrong, not just the surface mechanics.
3. **One page, one subject.** Each page covers one concept. Link to siblings instead of repeating
   them; a fact should live in exactly one canonical place.
4. **Native, plain English.** Short sentences, present tense, active voice. Dédalo is built by a
   Spanish-speaking team — copy-edit ESL phrasing into clear English, but never change a technical
   claim while doing so.
5. **Show, don't only tell.** Every non-trivial concept earns a concrete example — a JSON shape, a
   code snippet, a tipo, or a small table.
6. **Stable identifiers.** Code identifiers, ontology `tipo`s, class/method names, file paths,
   constants and config keys are reproduced **verbatim**. Never "correct" them.
7. **Document the engine as it is.** This manual describes the *current* engine, and nothing else.
   The v7 server was rebuilt from a previous engine, and that history has exactly two homes: the
   [rewrite narrative](../rewrite.md), and the two v6-upgrade pages — where the old configuration
   files are named because they are the *input* you are converting. Anywhere else, describe what
   the code does today. A design is never justified by comparison to a system the reader has never
   heard of; write the statement, not the contrast. **This is mechanically enforced** by
   `test/unit/docs_current_engine_tripwire.test.ts`, which also fails on a link into the
   gitignored internal-process directory, or any link that escapes `docs/`.
8. **Never document a feature the engine does not have.** If you find a page describing something
   that does not exist in `src/`, delete the section — a manual that promises an absent feature is
   worse than silence. If you cannot tell, say so in your PR rather than writing a `TODO` into the
   page.

## Toolchain

The site is **MkDocs + Material for MkDocs** (`mkdocs.yml`). Four commands are the whole
workflow — a first-time set-up, then the loop:

```bash
bun run docs:setup      # once per clone: virtualenv + the pinned toolchain
bun run docs:serve      # live preview on :8000 while you write
bun run docs:build      # mkdocs build --strict — the same build the publish runs
bun run docs:publish    # gates, then upload to dedalo.dev/docs/v7/
```

`docs:publish` **is** the gate, not a wrapper around it. It runs the content checks and the
strict build first and refuses to upload if either is red, writing nothing. There is no
override flag: a broken link never reaches a reader, and you never have to remember to run
anything beforehand.

Publishing needs two entries in `../private/.env` — the destination, and the SSH port if it
is not 22. Keep them separate; a port folded into the target reaches `rsync` as part of one
argument and fails:

```bash
DEDALO_DOCS_RSYNC_TARGET="user@host:/home/www/vhosts/dedalo.dev/httpdocs/docs"
DEDALO_DOCS_SSH_PORT=22
```

Use key authentication (`ssh-copy-id -p <port> user@host`) rather than a password, so a
publish never stops to prompt.

An optional third key mirrors the published tree into a local docs root, for previewing
the site as served — both versions side by side, with the switcher working:

```bash
DEDALO_DOCS_STAGE_DIR="/path/to/website/checkout/docs"
```

Both paths are the docs **root**; the command appends `v7/` itself, so it can never
overwrite another version's tree. The mirror is refreshed from the same build that was
just uploaded, which is the point — a copy maintained by hand goes stale without saying so.
The routing `.htaccess` is deliberately *not* mirrored: its rules are absolute (`/docs/v7/`)
and would misdirect a preview served under a different path prefix.

The enabled Markdown extensions you may rely on:

| Feature | Extension | Use |
| --- | --- | --- |
| Admonitions (`!!! note`) | `admonition` | callouts (see below) |
| Collapsible blocks (`???`) | `pymdownx.details` | long, optional detail |
| Mermaid diagrams | `pymdownx.superfences` | flow/ER/sequence diagrams |
| Footnotes (`[^1]`) | `footnotes` | asides and definitions |
| Inline attributes (`{width="20"}`) | `attr_list` | image sizing, ids |
| HTML in Markdown | `md_in_html` | rare, only when Markdown can't express it |
| Code titles & highlight | `pymdownx.highlight` | `` ```js title="wrong!" `` |

There is no `nav:` block — navigation is the curated `index.md` reading paths plus per-directory
`index.md` hubs. When you add a page, link it from the relevant hub and, if cross-cutting, from the
root [`index.md`](../index.md) section index.

Sidebar **order** inside a directory is alphabetical by filename unless the directory has a `.pages`
file. It lists the pages in reading order (mirror the hub's link order) and ends with `...`, which
places every unlisted page after them, alphabetically — so a new page still appears without editing
it. A name that does not exist fails the build (strict or not).

### Renaming or deleting a page

The manual is published one prefix per major version (`dedalo.dev/docs/v7/`, with the frozen
v6 manual at `/docs/v6/`), so **every published page path is a public URL that other sites
link to**. Adding a page is free. Removing one is not: rename or delete a page and you must
add an entry to the `redirect_maps` block in `mkdocs.yml` pointing the old path at its
replacement, or at the nearest surviving hub.

This is enforced, not remembered. The publish records what it served, and the versioning
gate fails on any page that vanished without a redirect — so the redirect lands in the same
commit as the rename, or nothing publishes.

!!! warning "Write links to this version"
    A link to `dedalo.dev/docs/<path>` with no `v7/` in it only works through a server-side
    redirect whose target changes when the next major ships. Always write the version:
    `https://dedalo.dev/docs/v7/install/`. Inside the manual, use relative `.md` links as
    usual — they need no prefix.

## Page structure

Every page follows the same skeleton:

```markdown
# Page title

> See also: [Sibling](sibling.md) · [Parent hub](index.md)   ← optional but recommended

One- or two-sentence summary: what this page is and who needs it.

## First real section
...
```

Rules:

- **Exactly one H1** (`#`), and it is the page subject — match the file/concept name (a component
  reference page is titled `# component_image`, a concept page is `# Search Query Object (SQO)`).
- The optional **`> See also:`** line sits directly under the H1, links separated by ` · `.
- Open with a short **summary paragraph** before the first `##`. No wall of text, no history lesson
  unless the page is *about* history.
- Use `##`/`###`/`####` in order — never skip a level. Don't go deeper than `####`.
- **Sentence case** for all headings (`## Data management`, not `## Data Management`).
- A directory's `index.md` is its **hub**: a summary plus a linked, annotated list of the pages in
  that directory. Keep hub link lists in a stable order (conceptual, then alphabetical).

## Voice and terminology

Write in plain, native English. Common ESL fixes: *"is build on"* → *"is built on"*;
*"Dédalo use"* → *"Dédalo uses"*; *"his data"* (for an object) → *"its data"*; *"do a request"*
→ *"make a request"*.

Use the canonical spelling and casing for Dédalo terms — they are defined once in the
[Glossary](../understanding/glossary.md), link there rather than re-defining:

| Canonical | Notes |
| --- | --- |
| Dédalo | with the accent |
| section, component, area, tool, service, widget | lowercase in prose; `code` font for class names |
| `tipo` | lowercase, code font; plural *tipos* |
| matrix table, value item, datum, subdatum | as written |
| locator | lowercase |
| SQO, RQO, ddo, DDO map | acronyms uppercase in prose (`ddo` lowercase only as the literal key) |
| `lg-eng`, `lg-nolan`, `dd151`, `rsc197` | literal tipos/codes always in code font |
| work system, diffusion system | two words, lowercase |

Refer to the reader as **you**; refer to the system as **Dédalo** or **it**. Avoid "we" except in
the few intentionally narrative origin pages.

## Links and cross-references

- Internal links are **relative** and end in `.md` (`[Sections](../sections/index.md)`), so they
  work both in the repo and in the built site.
- Anchor links use the GitHub/MkDocs slug of the heading
  (`[nomenclature](index.md#definitions-of-dédalos-nomenclature)`).
- Link a term to its canonical page on first use in a page, not on every mention.
- A live ontology node is linked as `https://dedalo.dev/ontology/<tipo>` —
  e.g. [oh1](https://dedalo.dev/ontology/oh1).
- Don't link to source directories as if they were doc pages. Link to the sibling reference page
  when one exists; otherwise name the path in `code` font as plain text.

## Code, JSON and examples

- Always tag the fence language: `json`, `ts`, `js`, `sql`, `shell`, `bash`, `dotenv`, `nginx`, `mermaid`.
- **Examples must be real and correct.** Verify snippets against the code. Copy a real shape from
  the codebase rather than hand-writing one. Watch for typos in example code itself — e.g.
  `{ a : 1 ]` instead of `{ a : 1 }` is a bug to fix.
- Keep JSON examples minimal but complete: enough keys to be meaningful, trimmed of noise. Inline
  `// comments` are acceptable in illustrative JSON blocks (they signal "schematic, not literal").
- For "wrong vs right" pairs, use code titles:

  ````markdown
  ```js title="wrong!"
  import '../directory/file'
  ```
  ```js title="right"
  import '../directory/file.js'
  ```
  ````

- Component reference pages open with a JSON **Overview** block describing the typology flags
  (`could_be_translatable`, `is_literal`, `is_media`, `modes`, `default_tools`, `render_views`,
  `data`/`sample_data`, `value`/`sample_value`). Keep this convention and key order.

## Admonitions

Use Material admonitions for asides; keep the type honest:

```markdown
!!! note "Optional title"
    Context or a clarification.

!!! info "..."     general aside / pointer to a skill or deep doc
!!! warning "..."  data-loss, security or footgun — the reader must not miss it
!!! tip "..."      a shortcut or best practice
```

Use `(!)` inline only inside code comments, not in prose — in prose use a `!!! warning`.

## Diagrams and images

- Prefer **Mermaid** (`flowchart`, `erDiagram`, `sequenceDiagram`) over screenshots for anything
  structural — it stays correct and themes with the site.

!!! warning "A diagram cannot be checked on a local preview"
    Mermaid is vendored into the site at build time by the `privacy` plugin, and the plugin
    rewrites the asset to an **absolute** URL under `site_url`. A local preview therefore
    loads it from `dedalo.dev`, not from the copy you just built — so a diagram can look
    broken locally and be perfectly fine published, or the reverse. Check diagrams on the
    published site after `docs:publish`.

    This matters because the failure is silent: an unrenderable diagram degrades to a grey
    code block, the build stays green and the page looks deliberate. 83 diagrams sat broken
    that way until 2026-09-21, when the site's `Content-Security-Policy` turned out to be
    blocking the CDN the renderer came from. Do not remove the `privacy` plugin — the
    versioning gate refuses without it.
- Screenshots live under the nearest `assets/` directory; size with `{width="…"}` when needed and
  always give descriptive alt text: `![Dédalo ontology view](assets/…png)`.

## Tables and lists

- Use tables for fixed, enumerable facts (permission levels, config keys, type maps). Keep a header
  row and align the pipes for readability in source.
- Use ordered lists only for genuine sequences (steps, precedence). Otherwise use bullets.
- Each bullet in a hub/link list is `**[Title](path.md)** — one-line description.`

## Glossary entries

The [Glossary](../understanding/glossary.md) is the single source for term definitions. Each entry follows:

```markdown
### term
*SQL equivalent: closest standard analogue (or "No SQL equivalent.").*

One-paragraph definition.
See: [canonical doc](path.md). Related: [other term](#other-term), [another](#another).
```

Terms are alphabetical; codes (`dd151`) file under their first letter.

## Pre-commit checklist (per page)

- [ ] Exactly one H1; headings nested in order; sentence case.
- [ ] Summary paragraph under the H1; `> See also:` where it helps.
- [ ] English reads natively; no ESL slips; no Spanish left in prose.
- [ ] Every technical claim, identifier, tipo and path preserved verbatim and (where touched)
      verified against the code.
- [ ] Every code/JSON fence has a language tag and is syntactically valid.
- [ ] Internal links are relative, end in `.md`, and resolve.
- [ ] Terminology matches the canonical table above and the Glossary.
- [ ] Anything unverifiable is flagged, not invented.
