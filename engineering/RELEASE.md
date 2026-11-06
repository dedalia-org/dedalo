# RELEASE.md — publishing a code release from the master

The numbered runbook for cutting a release on the code master and making it
installable by every consumer install. The mechanism it drives lives in
`src/core/update/` (build: `code_build.ts`, manifest: `code_manifest.ts`,
serving: `code_serving.ts`, install side: `code_update.ts`); the operating
context (sentinel, rollback, deployment channels) is
`engineering/PRODUCTION.md` §12.

**The three channels (policy 2026-09-29; prerelease 2026-10-18).** A
PUBLISHED release (`<v>.zip`, advertised to every consumer) is built from a
stable **release tag** `vX.Y.Z` — a version that was cut and tagged, never a
moving branch tip. A PRERELEASE (`<X.Y.Z-beta.N>.zip`, offered only to
consumers that choose *Prereleases* or *Developer builds*, on a master with
`DEDALO_CODE_SERVER_PRERELEASE_CHANNEL=true`) is built from an annotated
prerelease tag `vX.Y.Z-(alpha|beta|rc).N` — immutable and sha-verified like a
release. The DEVELOPER channel (`<v>-dev.zip`, offered only to consumers that
choose *Developer builds*, on a master with `DEDALO_CODE_SERVER_DEV_CHANNEL=true`)
is the tip of branch **`master`**: the latest integrated code, before its
release. The consumer's choice is a LADDER — `master ⊂ prerelease ⊂ dev`, each
also offered what the one before it is (`code_manifest.ts channelExposure`);
the two master switches stay separate. The code server's checked-out branch is
irrelevant to all three; the refs are resolved on the server
(`code_build.ts resolveBuildRefOrRefuse`).

The example below publishes `7.0.1` from a master running `7.0.0`. Substitute
your versions; the walk is strictly linear (`code_manifest.ts` — the next
minor within the major, no skipping).

1. **Name the release.** `DEDALO_NEXT_RELEASE` in `src/core/update/version.ts`
   is the release an untagged tree is heading to (its nightlies are
   `<NEXT>-dev`). It equals the data triple until that release is tagged and is
   moved to the next patch triple by the post-release commit that follows the
   tag (VERSIONING_SPEC §6.4) — in the example, the commit after `v7.0.0` moved
   it to `[7, 0, 1]`. A tagged build must name its own triple: `NEXT` equals the
   tag's triple in the tagged commit (`data_version_tripwire`). The build reads
   the TAG's own `version.ts`, never the running process (step 6), and the
   manifest advertises releases strictly above the CONSUMER's identity and on
   the linear walk from it. The first prerelease tag (`7.0.1-beta.1`) is the
   first commit where this holds for the triple; later prereleases and the
   release repeat nothing (*Cutting a prerelease* below).

2. **Write the release plan in `install/update/catalog.json`.** The file is the
   update definition (owner decision D-7): one entry per release under
   `releases`, and the entry IS the plan every consumer's update run executes —
   the master publishes it with its code manifest (`get_code_update_info`,
   top-level `plans`, `src/core/update/release_plans_wire.ts`), so a consumer
   plans from the master's catalog, never from its own older one. Add `"7.0.1"`
   in the same commit as step 1:

   ```jsonc
   "7.0.1": {}                                   // code only: the default steps
   "7.1.0": {
     "compat": "incompatible",
     "steps": [
       { "kind": "code" },
       { "kind": "schema" },
       { "kind": "data", "sql": ["7.1.0/01_rename.sql"],
         "scripts": [{ "id": "…", "info": "…", "stop_on_error": true }] },
       { "kind": "ancillary" }
     ]
   }
   ```

   What the loader (`src/core/update/catalog_file.ts`) enforces — a bad file
   refuses at load, so it never ships (`update_catalog_json_tripwire`):
   - **The walk.** Keys are dotted triples in order, each the next rung
     (patch, minor `.0`, major `.0.0`) of the one before; the first is the next
     rung of the data line start (`DATA_LINE_START`, `7.0.0`), which is never a
     key itself. A data release's `from` is the previous data release, derived,
     never written.
   - **`steps`.** Absent = the default `code → ontology → schema → ancillary`.
     Declared: `code` exactly once; `schema`, `data`, `ancillary` at most once,
     after `code` (`step_placement`);
     `ontology` at most twice — one with `min` (a precondition the run executes
     BEFORE the swap; `min` is an earlier release of this catalog on the same
     data model) and one without (after the swap). The run's `ontology` phase
     (`src/core/update/run/ontology_phase.ts`) executes both; a step with `min`
     fails when the source offers an older ontology version.
   - **`compat`** (D-4). Required when the release declares a `schema`, `data`
     or `ontology` step, forbidden otherwise. `incompatible` (an SQL schema or
     data change: crossing it needs a human database restore, D-2) only on a
     minor or major; a `data` step is always `incompatible`. `compatible` (an
     index, an ontology change with no schema/data impact) may ride a patch.
   - **`data`.** SQL in files `install/update/<release>/<name>.sql`, one
     statement each (the atomic contract of `catalog.ts`); `scripts` key into
     `SCRIPT_REGISTRY` (`src/core/update/engine.ts`) — register the script
     there first; `order` (default `sql`, `scripts`).

   What the plan decides on the consumer (`src/core/update/run/rollback.ts`):
   after the swap, a failure rolls the code back automatically only while no
   `ontology`/`schema`/`data` phase of a release whose `compat` is not
   `compatible` has started; otherwise the run ends in `NEEDS_DB_RESTORE`. A
   release that declares no steps declares no `compat`, and its default
   `ontology` and `schema` phases therefore count as crossing the data model.
   Every release has an entry, even a code-only one (step 3, rule 3).

2a. **Set the data version, only for a data release.** A catalog entry with a
   `data` step moves the data version in the TAGGED commit, not before:
   set `DEDALO_DATA_VERSION` in `version.ts` to the entry's triple (`[7, 1, 0]`).
   `dataVersionOf` derives it from the catalog, and `data_version_tripwire` holds
   the constant to it on a tagged build. Until then nightlies stay on the data of
   the last data-changing release (VERSIONING_SPEC D2), so an untagged `7.1.0-dev`
   never carries the migration. A release without a `data` step leaves
   `DEDALO_DATA_VERSION` alone. A data release also recompiles the install seed
   for that data version (`bun run seed:build`, step 3 rule 4).

2b. **Bump a derivation version when the release changes what an ancillary
   reconciler derives.** The run's `ancillary` phase re-derives a surface only
   when its stamp moved. Two surfaces carry a hand-bumped version:
   `TEMPLATE_VERSION` (`src/core/media/protection.ts`, the generated media rule
   files) and `SEARCH_STORE_DERIVATION_VERSION` (`src/core/db/db_assets.ts`,
   the search stores' sync functions and backfill templates). Bump the version
   in the same commit as the change, then re-record the bank:
   `bun run scripts/derivation_versions.ts --update` (it refuses a hash that
   moved under an unchanged version, and a version that went backwards).
   `engineering/derivation_versions.json` is generated — never hand-edit it.
   Gate: `release_manifest_completeness_tripwire` (a moved hash under an
   unchanged version is a forgotten bump: no install would re-derive).

3. **Verify the gates.** `DEDALO_DATABASE_CONN=<suite db> bun test
   test/unit/…` for the touched surfaces, `bunx tsc --noEmit` (zero NEW
   errors), `bun run lint` on the touched files. **The release commit must
   have passed the FULL gate** (hermetic + db + instance): push it to a public
   mirror first (`bun run push`, or `git push github master` — public pushes are
   gated full) and let ci.yml + db.yml go green on GitHub. Two gates hold this:
   the pre-push hook refuses a release tag — stable `vX.Y.Z` or prerelease
   `vX.Y.Z-(alpha|beta|rc).N`, a prerelease IS a release — whose commit has no
   FULL green on the desk (it gates it full when the tag names HEAD), and image-release.yml's
   `plan` refuses a tag whose commit has no successful push run of BOTH ci.yml
   and db.yml. A push to the internal remote alone (gitdedalo — hermetic only)
   never qualifies a commit. **Cut the changelog in the release commit** —
   `bun run changelog release 7.0.1` writes `changes/7.0.1/release.json`
   (rules: `changes/README.md`) — **then tag that commit**
   with an ANNOTATED tag (`git tag -a v7.0.1 -m 'Dédalo 7.0.1' && git push <remote> v7.0.1`)
   — the engine reads its release identity from `git describe`, which ignores a
   lightweight tag, so a lightweight tag builds a tree calling itself `7.0.1-dev`
   (`src/core/update/release_identity.ts`); the pre-push hook REFUSES a
   lightweight release tag, and the code-server build refuses an archive that
   does not call itself the tag. The tag IS the release: its
   name and the commit's `version.ts` must agree. ONE check holds the four rules,
   every one read from the git objects of the tag's commit, never the working
   tree (`scripts/lib/release_tag.ts`):
   1. `version.ts` declares the tag's triple;
   2. the commit carries its changelog cut (`changes/<identity>/release.json`,
      version = the tag's identity, `to` = the tag);
   3. `install/update/catalog.json` has a `releases` entry for the tag's triple
      (step 2) — except the data line start (`DATA_LINE_START`), whose releases
      ride the seed, not a catalog rung. A release without an entry is never
      advertised by any master;
   4. the install seed manifest (`install/db/dedalo_install.manifest.json`)
      says `engine_version` = the commit's `DEDALO_DATA_VERSION` — a fresh install
      of the release starts on the data version the release declares (its
      freshness against its sources is `install_seed_manifest_tripwire`).

   A release tag is `vX.Y.Z` or `vX.Y.Z-(alpha|beta|rc).N`; a `-dev` name is
   never a release tag: `releaseVersionOfTag` answers null, so `releaseTagFault`
   refuses it (the image plan publishes nothing) and the push door holds nothing
   for it (exit 3).
   the pre-push hook runs it on every pushed `v*` tag (`bun run
   push:release-tag <tag> <commit> <object>`) and image-release.yml's `plan` runs it
   again. At the push door a tag whose identity sorts below `FIRST_CUT_RELEASE`
   (7.0.0-beta.6, the first release cut under the rule) is published history
   and passes with a note — `git push --tags` to a new mirror is never driven to
   `--no-verify`; `plan` stays strict. The code-server build also refuses a tag whose tree declares
   another version. Archives are built only with git >= 2.35 (the
   `%(describe:match=…,abbrev=…)` stamp; `MIN_GIT_FOR_DESCRIBE`) — the
   code-server build and the image pipeline refuse an older git. A prerelease
   tag (`v7.0.1-beta.1`) is built by the code server's *Build prerelease*
   (step 6) into `<X>/<X.Y>/7.0.1-beta.1.zip`, and its push publishes the image
   `:7.0.1-beta.1` (step 12). PHP-era tags
   (`v6.x`) are never candidates — a tag is publishable only if its tree
   carries `src/core/update/version.ts`.

4. **Bring the build checkout up to date**: `git fetch --tags` (and pull
   `master`) in `DEDALO_CODE_SERVER_GIT_DIR` — the panel reads LOCAL refs; a
   tag that was never fetched does not exist for it.

5. **Deploy the master itself.** The rule (policy, owner 2026-10-15): the code
   server runs the newest STABLE release it publishes, or a prerelease /
   developer build of the NEXT triple — it is never required to run each
   prerelease to serve it. Nothing mechanical ties the two: the archive is
   named from the tag's own `version.ts` (step 6) and the manifest's
   `info.version` (`serverVersion`, `code_manifest.ts`) is informational, so a
   master running `7.0.0` builds and serves `7.0.1-beta.1` (gate 13,
   `code_build_native`). For a STABLE release, deploy it now through the
   master's own channel (tree swap or image, `PRODUCTION.md` §12); after the
   restart the boot log and the maintenance area must both show `7.0.1`.

6. **Build the archive.** In the master's maintenance area, open the
   *serve code* panel and use its *Build release* button (served only when
   `IS_A_CODE_SERVER` is set and `DEDALO_CODE_SERVER_GIT_DIR` +
   `DEDALO_CODE_FILES_DIR` are configured). It archives the NEWEST release
   tag — the panel's *Release tag* row names it before you press — with
   `git archive --format=zip --prefix=dedalo_code/ refs/tags/v7.0.1`.
   *Build prerelease* beside it archives the newest prerelease tag that sorts
   ABOVE the newest release tag (the *Prerelease tag* row names it; it refuses
   when there is none — a beta a release superseded is never built) as
   `<X>/<X.Y>/<X.Y.Z-beta.N>.zip`. Both are IMMUTABLE: an identity already
   published (`.zip` + `.sha256`) is never rebuilt — the build refuses, and
   different bytes need a new tag. Before publishing, the build reads the
   archive's own `build_info.txt` back and refuses one that would not call
   itself the tag. The master does not have to RUN a prerelease to build it:
   the name comes from the tag's own `version.ts`, not the running process.

7. **Verify the artifact on disk:**
   `<DEDALO_CODE_FILES_DIR>/7/7.0/7.0.1.zip` **and** its `7.0.1.zip.sha256`
   sidecar. A release with no valid sidecar (missing, or not a plain 64-hex
   digest) is still ADVERTISED but NOT installable — the consumer refuses an
   archive it cannot verify. That is deliberate: a lost sidecar fails loudly
   at install time, never silently.

8. **Verify the serving URL.** The exact URL the manifest advertises:

   ```
   curl -fsS https://<master host>/dedalo/install/code/7.0.1/7.0.1.zip.sha256
   ```

   Serving is fail-closed (`code_serving.ts`): only with `IS_A_CODE_SERVER` +
   `DEDALO_CODE_FILES_DIR`, only that release's own `.zip`/`.sha256`, path
   re-derived through the same confinement gate the manifest uses.

9. **Verify discovery from a consumer.** On a consumer install pointed at
   this master, open the maintenance area's *update code* panel: it must
   offer `7.0.1` with its sha256.

10. **Install on the consumer.** The pipeline downloads, verifies the sha256,
   pre-validates and extracts to quarantine, installs dependencies there,
   smoke-boots, swaps, writes the sentinel, restarts (`PRODUCTION.md` §12).

11. **Confirm BOTH markers moved** on the consumer: the engine version
    (`7.0.1`) AND the build stamp shown in the maintenance area. A version
    that changed with a stale build stamp (or vice versa) means the swap did
    not land — investigate before calling the release done.

12. **The container image is published by the tag push.** Pushing `v7.0.1` (step 3)
    triggers `.github/workflows/image-release.yml`, which builds the product image from
    a `git archive` of the tagged commit — the same bytes as `7.0.1.zip` — for amd64 and
    arm64, signs it ONCE (cosign keyless) and copies the SAME digest to every provisioned
    registry of `engineering/image_registries.json` as `:7.0.1` (today
    `ghcr.io/dedalia-org/dedalo` and `docker.io/dedalia/dedalo`; the gitdedalo registry is
    skipped, not provisioned). The `publish` job waits for a reviewer of the
    `image-release` environment. Prerequisites: `ci/cosign.json` is pinned
    (`bun run ci:cosign:pin`), otherwise the run refuses to publish anything; and the
    `v*` tag ruleset exists (engineering/CI.md, activation runbook step 8) — only a
    release maintainer can push the tag, which is what makes the reviewer binding.
    Each arch's smoke test BOOTS the image's own server (no database) and requires its
    `/health` to serve `version` = the tag's identity (`7.0.1`) and `release_kind`
    `stable` — for a developer build, the identity its archive resolves to
    (`7.0.1-dev`, or the tag when the commit is exactly tagged).
    A PRERELEASE tag push (`v7.0.1-beta.1`) publishes the same way, held to the same
    gates (the release-tag check, a full green, the reviewer), as `:7.0.1-beta.1` ONLY —
    install-stamp channel `prerelease`, `/health` `7.0.1-beta.1` / `prerelease`. A run
    writes exactly one tag and never a floating one: no `latest`, no `:7` / `:7.0`, and
    a prerelease never touches `:7.0.1` (`image_release.ts` `publishTagFault`; gate:
    `image_release_native`). The workflow's trigger globs are wider than the tag grammar;
    `plan` refuses a non-canonical name (`v7.0.1-beta.01`).

13. **Check the publication.** The run's summary lists every registry (pushed /
    unchanged / skipped with its reason) and the digest; the `image-release` artifact is
    the same record as JSON. A skipped provisioned registry (`missing_secret: …`) is a
    red flag: add its secrets and dispatch the `release` channel for this tag. Then
    verify ONE target as an operator would (the identity is `signing.identity_regexp` of
    `engineering/image_registries.json` verbatim — it accepts stable and prerelease tags;
    `image_registries_docs_tripwire` holds this command equal to it):

    ```
    cosign verify ghcr.io/dedalia-org/dedalo@<digest> \
      --certificate-identity-regexp '^https://github\.com/dedalia-org/dedalo/\.github/workflows/image-release\.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?|heads/master)$' \
      --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
    ```

    A published release tag is IMMUTABLE: a re-run (or a release dispatch) never rebuilds
    it — it copies the digest that already exists, after checking its signature, and
    refuses when two registries disagree.

**No developer images.** The dev channel publishes NO container images: a `dev` dispatch
of `image-release.yml` is refused at its `publish` step by `image_release.ts`
(`publishTagFault`: the dev channel publishes nothing, to any registry). Docker images are immutable, and a docker or image install runs
tagged releases only (stable `X.Y.Z` or beta `X.Y.Z-beta.N`); it never accepts a `-dev`
image. The developer build (`<v>-dev.zip`, identity `X.Y.Z-dev`) is a TREE archive, and
nightlies reach production and dev installations through the code update path only.

**Emergency fix for a stable installation (Docker or tree).** It ships as a code-only patch tag
(for example `v7.0.1` over data `7.0.0`): the tag is a release of its own, its image is
published by the tag push like any release, and it installs as that release. No downgrade
on any channel; the order is `7.0.0` < `7.0.1-alpha.1` < `7.0.1-beta.1` < `7.0.1-rc.1` <
`7.0.1-dev` < `7.0.1` < `7.0.2` (the reference comparator is
`src/core/update/release_identity.ts`).
A tree install takes the same patch tag through the code update, never a nightly (VERSIONING_SPEC A1).

**A newly provisioned mirror** (e.g. the gitdedalo registry once its host exists) gets the
existing releases by a `release`-channel dispatch per tag (input `tag: vX.Y.Z`): it copies
the already-published, already-signed digest and never rebuilds. Provisioning itself is a
list edit (`engineering/CI.md`, *The product image*).

Note: there is no other code-delivery channel beside the update run (the panel
self-update and the image updater). The parked git-based `deploy/deploy.sh` and
its self-hosted workflow were deleted on 2026-10-30 (update audit U-34;
`engineering/CI.md` *Deploy*).

Automated twin: steps 1–11 are rehearsed end to end by
`bun run test:update` (`scripts/update_drill.ts`) — a scratch clone gets the
release commit and its `v<version>` tag, a real master instance builds and serves it, and a git-archive
copy installs it across the planned-death restart. Before that it runs the
PRERELEASE leg: the clone cuts `v<version>-beta.1`, `-beta.2` and `v<version>` on three
annotated commits, the master (prerelease channel on, running this checkout — never the betas it serves)
builds each (*Build prerelease* / *Build release*; a rebuild and a superseded beta
refused), a prerelease-channel consumer walks beta.1 → beta.2 → stable across three
restarts with `/health` naming each identity and digest, and stable-channel askers
are offered no beta at any point. Run it after changing
ANYTHING under `src/core/update/`, the update widgets, or `.gitattributes`
export rules; it is the only gate that exercises build → serve → discover →
install → restart as one wire-true sequence.

## Two official servers

Two servers publish Dédalo v7: **master7** (release: stable code, the official ontology) and **beta7**
(beta: prereleases and dev builds, ontology tested there). Roles are plain configuration, no engine concept:

| | master7 | beta7 |
|---|---|---|
| `IS_A_CODE_SERVER` | true | true |
| `DEDALO_CODE_SERVER_PRERELEASE_CHANNEL` / `DEDALO_CODE_SERVER_DEV_CHANNEL` | off | on |
| `IS_AN_ONTOLOGY_SERVER` | true | true |
| access code | its own | its own, distinct |

A server answers a manifest only to codes in its own config. The installer writes only master7 entries;
beta7 is an opt-in, commented example in `install/sample.env` with its own code.

**Promotion.** The ontology reaches master7 from beta7 through the normal update run: master7 lists beta7 in
`ONTOLOGY_SERVERS` with the tlds to promote (an entry without `tlds` is refused on an ontology server), and
runs Update ontology. Only the listed tlds move; census, recovery snapshot, digests and the data-model
refusal apply. Code is promoted by cutting the stable tag from the tested prerelease, as below.

## Cutting a prerelease

A prerelease (`vX.Y.Z-(alpha|beta|rc).N`) IS a release (owner Q1, 2026-10-15):
the same steps as above, held to the same gates, minus the version bump. The
example publishes `7.0.1-beta.2`.

1. **No version bump.** `version.ts` already declares `[7, 0, 1]` as NEXT — the
   `install/update/catalog.json` entry and, for a data release, `DEDALO_DATA_VERSION`
   (steps 1, 2, 2a) landed with the triple's first prerelease (`7.0.1-beta.1`); a
   later prerelease contributes none of them (the triple's data step runs once,
   on the first identity of it an install receives). Each tagged commit must hold
   the gates: `NEXT` equals the tag's triple, and `DATA` equals the catalog's
   derivation (`data_version_tripwire`). The tag's triple must equal the tree's
   `version.ts` — every door below refuses a disagreement.
2. **Cut the changelog** in the prerelease commit: `bun run changelog release
   7.0.1-beta.2` writes `changes/7.0.1-beta.2/release.json` (its notes are what
   the update panel shows for that row).
3. **FULL green on a public mirror** for that commit (step 3: ci.yml + db.yml
   on GitHub; the internal remote alone never qualifies).
4. **Annotated tag**: `git tag -a v7.0.1-beta.2 -m 'Dédalo 7.0.1-beta.2' &&
   git push <remote> v7.0.1-beta.2`. The pre-push hook holds it exactly as a
   stable tag (`scripts/lib/release_tag.ts`: annotated, the changelog cut, a
   FULL green); a lightweight tag is refused.
5. **Build prerelease on the code server**: `git fetch --tags` in
   `DEDALO_CODE_SERVER_GIT_DIR` (step 4), then *serve code* → *Build
   prerelease* (step 6) — its *Prerelease tag* row must name `v7.0.1-beta.2`.
   It writes `<DEDALO_CODE_FILES_DIR>/7/7.0/7.0.1-beta.2.zip` + `.sha256`
   (verify as step 7; URL
   `…/dedalo/install/code/7.0.1/7.0.1-beta.2.zip.sha256`, step 8). The code
   server does NOT deploy it (step 5): it keeps running its stable release. It
   OFFERS the archive only with `DEDALO_CODE_SERVER_PRERELEASE_CHANNEL=true`,
   and only to a consumer that chooses *Prereleases* or *Developer builds*;
   check both sides of step 9 — a *Published releases* consumer must NOT see it.
6. **Approve the image.** The tag push runs `image-release.yml` (step 12): a
   reviewer of the `image-release` environment approves `publish`, which pushes
   `:7.0.1-beta.2` ONLY — never `:7.0.1`, `:7.0`, `:7` or `latest`.
7. **cosign verify** one target exactly as step 13 (the same
   `identity_regexp` accepts prerelease tags).

A beta that a release has superseded is never built (*Build prerelease* only
sees prerelease tags above the newest stable one), and a published prerelease
is immutable like a release: different bytes need a new tag.

**Bootstrap (design §2.8 item 5).** An install running `7.0.0-beta.6` or
older has no `prerelease` channel token and calls itself the bare `7.0.0`, so
it is never offered a prerelease: it reaches the prerelease line by a fresh
image (`docs/install/docker.md`, *A stack installed from a beta before
7.0.0-beta.7*) or, on a tree install, through the dev channel: it installs the
`7.0.0-dev` developer build. From there no door moves it back: `7.0.0-dev`
sorts above every prerelease of `7.0.0`, so `code_manifest.ts`
`sameTripleItemsFor` offers only identities above it and `version_walk.ts`
`sameTripleRefusal` refuses anything not newer (the one same-identity move is
a `-dev` reinstalled over itself on the dev channel). Its way on is `7.0.0`
once tagged, or the next release.
