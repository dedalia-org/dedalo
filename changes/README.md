# changes/ — the source of the change log

`docs/change_log.md` (published at dedalo.dev/docs/v7/change_log/) is **generated**
from this directory by `scripts/changelog.ts`. Never edit the page; edit here.
Gate: `test/unit/change_log_tripwire.test.ts`.

## Who reads it

Institutions deciding whether to update, and what an update will do to their data,
their users and their configuration. Write for them, not for the commit log: say what
changed **for the reader**, and why it matters. The commit history stays in git; each
release names its range.

## Adding a note — in the same commit as the change

```bash
bun run changelog new <slug> --type fixed --audience user --title "…"
# edit changes/unreleased/<slug>.md, then:
bun run changelog            # re-render docs/change_log.md, commit both
```

One file per change, so two branches never conflict on it. A fragment:

```markdown
---
title: Logging in no longer asks for the credentials twice.
type: fixed
audience: user
date: 2026-08-13
breaking: false
wc: WC-2026-09-23-relation-q-is-a-locator
---
Body in markdown: what the reader saw before, what they see now.
```

| key | required | values |
|---|---|---|
| `title` | yes | one line of inline markdown — the change, stated to the reader |
| `type` | yes | `security`, `removed`, `deprecated`, `changed`, `added`, `fixed` (the page's order) |
| `audience` | yes | `user` (uses the application), `admin` (installs and runs it), `developer` (builds on its API) |
| `date` | yes | `yyyy-mm-dd`, the day the change landed; orders entries newest first |
| `breaking` | no | `true` when the reader must **do** something on update (rename a config key, re-index…) — it is listed in the release's *Action needed* box |
| `wc` | no | comma list of wire-contract ids this change adopted |

The body is rendered inside a list item under the page's own headings, so it may not
contain headings. It is part of the manual: links are relative to `docs/change_log.md`
(e.g. `./core/system/login.md`), and the manual's rules apply (no PHP, links resolve —
`docs_current_engine_tripwire`).

Worth a note: anything a user, an administrator or an API consumer would notice.
Not worth one: refactors, test-only changes, internal tooling — the release's commit
range covers them.

**Every wire-contract entry** (`engineering/wire_contract/`) adopted from 2026-09-26 on
must be cited by a fragment's `wc:` — a deliberate wire change is a reader-visible change.

## Cutting a release

```bash
bun run changelog release 7.0.1            # --from <tag> only for the first release
git add changes docs/change_log.md && git commit -m "release: 7.0.1"
git tag -a v7.0.1 -m 'Dédalo 7.0.1'   # annotated: a lightweight tag builds a '.dev' identity
```

`release` moves `unreleased/` into `changes/<version>/` and freezes `release.json`: the
date, the tag range, the commit count (git is read here, once) and the wire-contract
ids no earlier release claimed. From then on the page is a pure function of this
directory, which is what lets the gate re-render it without git.

It also **seals the release triple's migrations** (owner ruling C31, 2026-11-13): the
first build of `X.Y.Z` — its first prerelease, or the release itself — writes the set of
`incompatible` migrations the ledger assigns to that triple into
`install/db/migrations.sealed.json` (commit it with the cut). From then on an
`incompatible` migration added to a sealed triple fails `migration_content_hash_tripwire`
and must move to the next minor; a `compatible` one may still join it. A later cut of the
same triple (`7.0.1-beta.3` after `7.0.1-beta.2`) changes nothing.

It also freezes the release's **notes** into `release.json` — the *Action needed*
titles and one `{type, audience, title}` per fragment, in the page's order:

```json
"notes": {
	"action_needed": ["…the title of each `breaking: true` fragment…"],
	"entries": [{ "type": "fixed", "audience": "user", "title": "…" }]
}
```

A code server hands these to every installation's **Update code** panel with the
release it advertises, so the operator reads what a version changes before installing
it. They are derived, never written by hand: the gate holds every snapshot's notes
equal to its fragments' titles, so **a fragment's title is what an operator reads in
the panel** — write it as a sentence that stands alone. Snapshots cut before
2026-10-09 carry no notes, and the panel shows none for them.

## History

Before 2026-09-26 the page was hand-written. Its entries were migrated into fragments,
each filed under the release whose tag first contained it (by git ancestry of the entry,
or of its wire-contract entry when that came first); the release snapshots for
7.0.0-beta.2 → beta.4 were rebuilt from the tags the same way.
