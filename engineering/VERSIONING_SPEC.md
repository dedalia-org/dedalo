# Versioning spec — builds, installs, data

**Status:** APPROVED 2026-10-27 by the owner (decisions D1–D6 in §8). D1 AMENDED 2026-10-28 (amendment A1 in §8). The code, gates and operator docs must satisfy it. Where they disagree, this spec wins. §4, §5, §6, §7 and §9 rewritten 2026-11-12 (T1-25) to the shipped state; §4 rule 8 records the owner ruling of 2026-11-11 on rollback.

This spec says what a version *means* and what each install is allowed to take. The code, gates and operator docs must agree with it. Where they disagree, this spec wins and the disagreement is a bug.

---

## 1. Vocabulary

Use these words, and only these, in code comments, gates, docs and messages.

| Term | Meaning |
|---|---|
| **Release** | A stable git tag `vX.Y.Z`. Named `X.Y.Z`. |
| **Beta** | A prerelease git tag `vX.Y.Z-beta.N`. Named `X.Y.Z-beta.N`. (`alpha` and `rc` follow the same rule.) |
| **Nightly** | An untagged build, from a commit with no release tag. Named `X.Y.Z-dev`, where `X.Y.Z` is the next release. Tree-only. |
| **Next release** | The release the code is building toward. Held by `DEDALO_NEXT_RELEASE`. |
| **Data version** | The last release that changed data. Held by `DEDALO_DATA_VERSION` (see §5). |
| **Code version** | The release identity of the running tree or image (`7.0.0`, `7.0.0-beta.7`, `7.0.1-dev`). |
| **Image** | A Docker image. Exists only for a release or a beta. |
| **Tree install** | An install that runs from a git checkout and updates through the code update path. |

**Do not use "dev image".** No Docker image is ever built for a nightly.

---

## 2. Build types

| Build | Git state | Identity | Docker image | Tree archive |
|---|---|---|---|---|
| Release | commit tagged `vX.Y.Z` | `X.Y.Z` | `X.Y.Z` | `X.Y.Z` |
| Beta | commit tagged `vX.Y.Z-beta.N` | `X.Y.Z-beta.N` | `X.Y.Z-beta.N` | `X.Y.Z-beta.N` |
| Nightly | untagged commit | `X.Y.Z-dev` (next release) | never | `X.Y.Z-dev` |

A tagged commit is never a nightly (§8, D3).

---

## 3. Install types and what each may take

Ordering, lowest to highest: `7.0.0-beta.6 < 7.0.0-beta.7 < 7.0.0-dev < 7.0.0 < 7.0.1-alpha.1 < 7.0.1-beta.1 < 7.0.1-rc.1 < 7.0.1-dev < 7.0.1 < 7.0.2`.

Nothing ever moves to a lower identity, on any install type or channel.

| Install | May take | May NOT take |
|---|---|---|
| **Docker** | Its own release or beta image, and any higher release or beta image. | Any `-dev` image, on any channel. Any lower identity. |
| **Tree, master channel** | Releases above its own. Never a nightly (A1). | Nightlies. Betas. Lower identities. |
| **Tree, prerelease channel** | Betas and releases above its own. Never a nightly (A1). | Nightlies. Lower identities. |
| **Tree, dev channel** | Nightlies, betas and releases above its own (the channel ladder: dev also sees what the prerelease channel sees). A nightly moves forward to the release it names. | Lower identities. |

Each rung also needs the code server's own opt-in: betas are offered only when it sets `DEDALO_CODE_SERVER_PRERELEASE_CHANNEL`, nightlies only with `DEDALO_CODE_SERVER_DEV_CHANNEL`.

A dev install of `7.0.0-dev` moves to `7.0.0`, then to `7.0.1-beta.N`, `7.0.1-dev` or `7.0.1`, whichever is next. It never moves back to a beta of the same triple.

**The post-tag gap (expected, not a fault).** The order ranks every `-dev` above every beta of its triple, whatever the build date. So a nightly built *before* a beta is cut is older code than that beta, yet the beta is never offered to it (it would be a downgrade by identity). And while the `master` tip is the tagged commit itself, *Build developer release* cannot build a new nightly (D3: it refuses "'master' is the tagged commit …"). The gap closes with the next commit on `master`: its nightly, still `7.0.0-dev`, carries the beta's code and more; the dev channel offers a same-identity nightly as a reinstall (the one equal case), so the dev install takes it. Ordering by commit ancestry instead would close the gap at once, but needs the asker's commit on the wire and a git-ancestry check on the code server, for a window that one commit ends.

---

## 4. Data rules

The catalog is `install/update/catalog.json` (grammar and validator: `src/core/update/catalog_file.ts`). Each release declares `compat` (`compatible` or `incompatible`, or none for a code-only release) and, optionally, its `steps` (`code`, `ontology`, `schema`, `data`, `ancillary`).

1. **An `incompatible` change (SQL schema or data) ships only in a minor or major release, never a patch.** A `data` step makes the release `incompatible`. A `compatible` schema or ontology change may ride a patch. The validator refuses an `incompatible` patch, a `data` step declared `compatible`, and a release with a `schema`, `data` or `ontology` step that declares no `compat`; after the line start (`DATA_LINE_START`, `7.0.0`) a migration needs a release that declares `compat`, and an `incompatible` migration needs an `incompatible` release (`migration_content_hash_tripwire`). The line start `7.0.0` is exempt: its builds carry the line's first migrations, `incompatible` ones included, with no catalog rung (`update_docs_claims_tripwire` C11 holds every statement of this rule to the ledger).
2. **Between data changes, the code runs on the data of the last data-changing release.** Every release in between is data-compatible with it.
3. **Every release has a catalog entry**, even a code-only one (`{}`). The key is the dotted triple of the release (`'7.0.1'`, `'7.11.1'`), never a concatenation (D5). An entry that declares no steps runs the default order `code → ontology → schema → ancillary`; a `data` step is never a default.
4. **A data change is a `data` step** (`sql` files and/or registered `scripts`, in `order`). Its `from` is derived (the previous data release), never declared. It runs in one transaction; the `matrix_updates` row is written only on commit.
5. **Ontology changes that do not touch existing data** (a label, a list of components) ship in any version of their minor. They do not move the data version.
6. **Nightlies never carry data changes** (see D2). A data change is first shipped in a beta.
7. **The update run applies the data change itself.** A code update (*Maintenance → Update code*, or `bun run update`) puts the installation in maintenance mode, takes or proves a fresh backup, swaps the code and runs each walked release's steps, its `data` step included. There is no separate *Update data* and no script the operator runs.
8. **Rollback across a data model.** After the code swap, a failure puts the previous code back automatically (`ROLLED_BACK_CODE`) unless a database phase (`ontology`, `schema`, `data`) of a WALKED `incompatible` release — one whose triple is above the installed one — has started; then the run ends in `NEEDS_DB_RESTORE` (D-2: a human restores the database with the code). A code-only release and a same-triple run (a prerelease to its next prerelease or its stable, a nightly reinstall) are not counted as crossings (owner ruling 2026-11-11). For a code-only release after the line start this is a checked property (rule 1). For a same-triple run it is the ruling only: nothing holds the builds of one triple to one data model (`7.0.0-beta.8` added an `incompatible` migration over `7.0.0-beta.7`), so such a run's automatic rollback can put back code that does not fit the database; no gate refuses an `incompatible` migration added to a triple after its first build (open, an owner decision). Anything unknown fails closed: a walked release with no plan, a code-only release that declares a database step, an unreadable installed release. The one predicate: `src/core/update/run/rollback.ts`.

---

## 5. Version constants

One constant per meaning, all in `src/core/update/version.ts` (the only module that may hold a version literal — `update_ownership_tripwire`):

| Name | Holds | Value | Rule |
|---|---|---|---|
| `DEDALO_DATA_VERSION` | The data version, `[major, medium, minor]` | `[7, 0, 0]` | The last data-changing release. Hand-set in the tagged commit of a data release, and held equal to what the catalog derives (`dataVersionOf`) by `data_version_tripwire` (D4). |
| `DATA_LINE_START` | The first data version of the line | `[7, 0, 0]` | A build with no data entry below its next release is at this triple. |
| `DEDALO_NEXT_RELEASE` | The release the code builds toward | `[7, 0, 0]` | Hand-set. Names the nightly (`7.0.0-dev`). Moves to the next patch triple in the post-release commit (§6). Never below the data version (`data_version_tripwire`). |

No string copy of a triple exists: text comes from `formatVersion(triple)` (`'7.0.0'`); comparisons use the triple (`compareVersionArrays`). The code version (`7.0.0-beta.7`) is the release identity, derived from the git tag (`release_identity.ts`, `build_stamp.ts`), not a constant.

**Wire keys do not change.** The browser receives `dedalo_data_version` and `dedalo_version`.

---

## 6. Release procedure

1. Confirm the catalog has an entry for the target release (`{}` for a code-only one).
2. Tag the commit (`vX.Y.Z` or `vX.Y.Z-beta.N`).
3. Build the Docker image for that tag, if the tag is a release or a beta.
4. If the release is stable, move `DEDALO_NEXT_RELEASE` to the next patch triple in a follow-up commit.
5. If the release changed data, confirm `DEDALO_DATA_VERSION` matches the catalog entry.
6. Publish the operator notes: which version Docker installs take, and whether the release changes data (its update run then runs a `data` phase and cannot be rolled back without a database restore).

The full procedure is `engineering/RELEASE.md`.

---

## 7. Scenarios (acceptance)

Each scenario has a gate.

| # | Situation | Expected | Gate |
|---|---|---|---|
| S1 | Docker `7.0.0-beta.7` → `7.0.0` | Allowed. Same data. | `release_identity_walk_native` (same-triple walks), `image_update_channel_native` (check-target census) |
| S2 | Docker `7.0.0` → `7.0.1` (code-only patch) | Allowed. No data phase. | `image_update_channel_native` (check-target census: next patch) |
| S3 | Docker asked for a `-dev` image | Refused, with a message saying Docker has no nightly images. | `image_update_request_native`, `image_update_script_native` (a -dev target is refused …), `image_release_native` (the DEV channel is REFUSED by plan) |
| S4 | Docker `7.0.1` asked for `7.0.0` | Refused as a downgrade. | `image_update_channel_native` (check-target census: downgrade), `release_identity_walk_native` |
| S5 | Tree dev channel `7.0.0-beta.7` takes nightly `7.0.0-dev` | Allowed (forward). | `code_update.test.ts` (developer archive walk, S5) |
| S6 | Tree master channel `7.0.0` is offered nightly `7.0.1-dev` | Not offered (per D1, A1). | `code_manifest.test.ts` (a -dev build on disk is NEVER advertised …) |
| S7 | Tree installs `7.1.0`, a minor with data steps | The run's `data` phase moves the data version, its own rung only. | `update_run_data_rung_native`, `update_full_drill_native` |
| S8 | A patch `7.0.1` declares data steps | Refused by the catalog validator. | `update_catalog_json_tripwire` (compat D-4: incompatible on a patch, data declared compatible) |
| S9 | A commit tagged `v7.0.1` is built as a nightly | Refused (per D3). | `code_update.test.ts` (S9), `code_build_native.test.ts` |
| S10 | Nightly `7.0.0-dev` installed, then `7.0.0` released | Dev install moves to `7.0.0`. Nothing moves back. | `code_update.test.ts` (S10) |
| S11 | Nightly `7.0.0-dev` (built before the tag) installed, then `v7.0.0-beta.8` published | The beta is NOT offered on any channel (lower identity). Until a new commit lands on `master`, *Build developer release* refuses (D3); the next nightly (same identity) is offered as a reinstall. | `code_manifest.test.ts` (a DEVELOPER build is offered … never the prereleases below it; a dev build reinstalled over ITSELF … the one equal case), `code_build_native.test.ts` (the tagged-commit refusal) |
| S12 | Tree dev channel `7.0.0` is offered `7.0.1-beta.1` | Offered (higher identity; the dev channel includes the prerelease rung). | `code_manifest.test.ts` (THE LADDER) |
| S13 | A code-only patch (`7.0.0` → `7.0.1`, no `compat`) fails after the swap | `ROLLED_BACK_CODE`; the rollback sentinel is never marked `needs_restore`. | `rollback_predicate_native` (owner ruling 2026-11-11), `update_run_resume_native` (T1-25) |
| S14 | A same-version run (`7.0.0-beta.7` → `7.0.0-beta.8`, a prerelease → its stable, a nightly reinstall) fails after the swap | `ROLLED_BACK_CODE`, whatever the catalog says of the triple. | `rollback_predicate_native`, `update_run_resume_native` (T1-25), `update_docs_claims_tripwire` (C3) |
| S15 | An `incompatible` minor fails after its first database phase started | `NEEDS_DB_RESTORE`; the sentinel is marked before that phase runs. | `rollback_predicate_native`, `update_run_resume_native` (an incompatible data phase failing) |

---

## 8. Decisions

**Approved by the owner, 2026-10-27:** D1 b (amended to a by A1, 2026-10-28), D2 b, D3 a, D4 b with the gate from a, D5 b, D6 as written in §5.

The text below records each decision and the options considered.

**D1 — Who receives nightlies?**
- Option a: only the dev channel. (Current code.) A stable tree install gets no emergency nightly.
- Option b: the dev channel, plus an explicit operator opt-in for a stable tree install to take a nightly in an emergency.
- **Recommendation:** b. The opt-in must be explicit and must say the install is running unreleased code.

**D2 — Can a nightly carry a data change?**
- Option a: yes. The nightly of the next minor runs its own data steps.
- Option b: no. Data changes ship only in a beta or release. A dev install of a data-changing minor waits for its beta.
- **Recommendation:** b. A nightly is not a release, so its migration has no reviewed identity.

**D3 — Can a commit carrying a release tag be a nightly?**
- Option a: refuse it. A tagged commit is a release or beta, and it is named by its tag.
- Option b: allow it, and keep the nightly name in the build stamp.
- **Recommendation:** a. Option b makes a nightly call itself a release after install, which breaks the dev channel's ordering.

**D4 — How are the constants kept correct?**
- Option a: keep them hand-set, with a gate that checks `NEXT` is never below the data version and that the data version has a catalog entry.
- Option b: derive the data version from the catalog (the highest entry with `updateData: true` at or below the release), and keep only `NEXT` hand-set.
- **Recommendation:** b, with the gate from a.

**D5 — Catalog key format.**
- Option a: keep the concatenated key (`'701'`). Rejected: it collides (`'7110'` for both `7.1.10` and `7.11.0`).
- Option b: dotted triple (`'7.0.1'`, `'7.11.1'`). Matches the release identity and the git tag, so nothing needs translating.
- **Recommendation:** b. It touches `catalogKeyOf`, the key lookup in `getMatchedDescriptor`, the catalog tripwires and the test fixtures that index by key. `scripts/update_probe.ts` builds a rung key and must change with it. The PHP engine that used `'701'` is frozen, so it does not constrain this.

### Amendment A1 — D1 becomes option a (2026-10-28)

**Decision:** D1 is **option a**: only the dev channel receives nightlies. No emergency opt-in exists on any tree install.

**Why:** an opt-in creates a second update path that bypasses the gates, the changelog, the catalog entry and the image build, and it runs unreleased code on a long-lived heritage install. An emergency fix goes out as a patch tag instead (`engineering/RELEASE.md`, *Emergency fix*), through the same gates as any release. Option a is also what the code already does, so nothing needs building.

**Effect:**
- §2 and §3: a stable or prerelease tree install is never offered a nightly. The dev channel is unchanged.
- §7 S6 stays as written ("not offered").
- D2 and D3 are unchanged. D2 means a nightly never carries a data change, so no unreleased build can migrate data.
- `engineering/RELEASE.md` *Emergency fix*: the patch-tag route covers tree installs as well as Docker.

---

## 9. Gates

- Ordering: the comparator matches §3 for every pair in the ordering fixture — `release_identity_native` (GATE 8).
- Install acceptance: the §7 Gate column, one per scenario.
- Data: a patch with data steps is refused, a data step is `incompatible`, a database step needs `compat` — `update_catalog_json_tripwire`; `DEDALO_DATA_VERSION` is what the catalog derives — `data_version_tripwire`; a nightly carries no data entry — `nightly_no_data_tripwire`.
- Next release: `DEDALO_NEXT_RELEASE` is never below `DEDALO_DATA_VERSION` — `data_version_tripwire` (NEXT is never below DATA).
- No `-dev` image name appears in the Docker pull, build or publish path — `image_update_script_native`, `image_update_request_native`, `image_release_native`.
- Rollback (§4 rule 8): `rollback_predicate_native`, `update_run_resume_native`, `update_docs_claims_tripwire` (the operator table measured against `rollback.ts`).

---

## 10. Out of scope

- The internal layout of the update engine, which is covered by its own specs.
- Ontology versioning, which follows `docs/administration/updates/updating_ontology.md`.
- Backup and restore.
