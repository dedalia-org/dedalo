# RELEASE.md — publishing a code release from the master

The numbered runbook for cutting a release on the code master and making it
installable by every consumer install. The mechanism it drives lives in
`src/core/update/` (build: `code_build.ts`, manifest: `code_manifest.ts`,
serving: `code_serving.ts`, install side: `code_update.ts`); the operating
context (sentinel, rollback, deployment channels) is
`engineering/PRODUCTION.md` §12.

**The two channels (policy 2026-09-29).** A PUBLISHED release (`<v>.zip`,
advertised to every consumer) is built from a stable **release tag**
`vX.Y.Z` — a version that was cut and tagged, never a moving branch tip. The
DEVELOPER channel (`<v>-dev.zip`, offered only to consumers that ask, on a
master with `DEDALO_CODE_SERVER_DEV_CHANNEL=true`) is the tip of branch
**`master`**: the latest integrated code, before its release. The code
server's checked-out branch is irrelevant to both; the refs are resolved on
the server (`code_build.ts resolveBuildRefOrRefuse`).

The example below publishes `7.0.1` from a master running `7.0.0`. Substitute
your versions; the walk is strictly linear (`code_manifest.ts` — the next
minor within the major, no skipping).

1. **Bump the engine version.** Edit `DEDALO_VERSION_TRIPLE` in
   `src/core/update/version.ts` to `[7, 0, 1]`. The master must RUN the
   version it publishes — the manifest advertises releases strictly above the
   consumer's version and on the linear walk from it.

2. **Add the catalog descriptor.** Append a `7.0.1` `UpdateDescriptor` to
   `UPDATE_CATALOG` (`src/core/update/catalog.ts`) stating what the release
   needs: `updateData: false` for a code-only release, or the
   `sqlUpdate`/`runScripts` steps for a data migration. Script steps key into
   `SCRIPT_REGISTRY` (`src/core/update/engine.ts`) — register the script
   there first.

3. **Verify the gates.** `DEDALO_DATABASE_CONN=<suite db> bun test
   test/unit/…` for the touched surfaces, `bunx tsc --noEmit` (zero NEW
   errors), `bun run lint` on the touched files. **The release commit must
   have passed the FULL gate** (hermetic + db + instance): push it to a public
   mirror first (`bun run push`, or `git push github master` — public pushes are
   gated full) and let ci.yml + db.yml go green on GitHub. Two gates hold this:
   the pre-push hook refuses a `vX.Y.Z` tag whose commit has no FULL green on
   the desk (it gates it full when the tag names HEAD), and image-release.yml's
   `plan` refuses a tag whose commit has no successful push run of BOTH ci.yml
   and db.yml. A push to the internal remote alone (gitdedalo — hermetic only)
   never qualifies a commit. **Tag the release commit**
   (`git tag v7.0.1 && git push <remote> v7.0.1`). The tag IS the release: its
   name and the commit's `version.ts` must agree (the build refuses a
   `v7.0.1` tag whose tree declares another version), and prerelease tags
   (`v7.0.1-beta.1`) are never published: while a major is in beta there is
   no release, and its code reaches installations only as developer builds of
   `master`. PHP-era tags (`v6.x`) are never candidates — a tag is publishable
   only if its tree carries `src/core/update/version.ts`.

4. **Bring the build checkout up to date**: `git fetch --tags` (and pull
   `master`) in `DEDALO_CODE_SERVER_GIT_DIR` — the panel reads LOCAL refs; a
   tag that was never fetched does not exist for it.

5. **Deploy the master itself** so it RUNS what it publishes (its own channel:
   tree swap or image, `PRODUCTION.md` §12). After the restart the boot log
   and the maintenance area must both show `7.0.1`.

6. **Build the archive.** In the master's maintenance area, open the
   *serve code* panel and use its *Build release* button (served only when
   `IS_A_CODE_SERVER` is set and `DEDALO_CODE_SERVER_GIT_DIR` +
   `DEDALO_CODE_FILES_DIR` are configured). It archives the NEWEST release
   tag — the panel's *Release tag* row names it before you press — with
   `git archive --format=zip --prefix=dedalo_code/ refs/tags/v7.0.1`.

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

13. **Check the publication.** The run's summary lists every registry (pushed /
    unchanged / skipped with its reason) and the digest; the `image-release` artifact is
    the same record as JSON. A skipped provisioned registry (`missing_secret: …`) is a
    red flag: add its secrets and dispatch the `release` channel for this tag. Then
    verify ONE target as an operator would:

    ```
    cosign verify ghcr.io/dedalia-org/dedalo@<digest> \
      --certificate-identity-regexp '^https://github\.com/dedalia-org/dedalo/\.github/workflows/image-release\.yml@refs/(tags/v[0-9]+\.[0-9]+\.[0-9]+|heads/master)$' \
      --certificate-oidc-issuer 'https://token.actions.githubusercontent.com'
    ```

    A published release tag is IMMUTABLE: a re-run (or a release dispatch) never rebuilds
    it — it copies the digest that already exists, after checking its signature, and
    refuses when two registries disagree.

**Developer images** (`:<v>-dev`, the twin of `<v>-dev.zip`) come only from a manual
dispatch of `image-release.yml` on branch `master` with channel `dev`; each dispatch
overwrites the previous dev image of that version.

**A newly provisioned mirror** (e.g. the gitdedalo registry once its host exists) gets the
existing releases by a `release`-channel dispatch per tag (input `tag: vX.Y.Z`): it copies
the already-published, already-signed digest and never rebuilds. Provisioning itself is a
list edit (`engineering/CI.md`, *The product image*).

Note: `deploy/deploy.sh` is a PARKED git-based deploy that has never run
against a real host — it is not a step of this runbook.

Automated twin: steps 1–11 are rehearsed end to end by
`bun run test:update` (`scripts/update_drill.ts`) — a scratch clone gets the
release commit and its `v<version>` tag, a real master instance builds and serves it, and a git-archive
copy installs it across the planned-death restart. Run it after changing
ANYTHING under `src/core/update/`, the update widgets, or `.gitattributes`
export rules; it is the only gate that exercises build → serve → discover →
install → restart as one wire-true sequence.
