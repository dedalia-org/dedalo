# Versioning spec — builds, installs, data

**Status:** APPROVED 2026-10-27 by the owner (decisions D1–D6 in §8). D1 AMENDED 2026-10-28 (amendment A1 in §8). The code, gates and operator docs must satisfy it. Where they disagree, this spec wins.

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
| **Tree, dev channel** | Nightlies and releases above its own. A nightly moves forward to the release it names. | Lower identities. |

A dev install of `7.0.0-dev` moves to `7.0.0`, then to `7.0.1-dev` or `7.0.1`, whichever is next. It never moves back to a beta of the same triple.

---

## 4. Data rules

1. **Data changes ship only in a minor or major release.** A patch release never changes data, and the catalog validator refuses a patch with data steps.
2. **Between data changes, the code runs on the data of the last data-changing release.** Every release in between is data-compatible with it. A patch or minor without data steps needs no Update data.
3. **Every release has a catalog entry**, even a code-only one (`updateData: false`). The catalog is keyed by the target release as a dotted triple: `7.0.1` is the key `'7.0.1'`, and `7.11.1` is `'7.11.1'`. Concatenated keys such as `'701'` are not allowed: `(7,1,10)` and `(7,11,0)` both read `'7110'`, so the key cannot say which release it names. The key must equal the entry's own `versionMajor.versionMedium.versionMinor`, and the validator refuses any entry where it does not (see D5).
4. **A data change is declared by a catalog entry with `updateData: true`**, with its `from` version and its steps (`sqlUpdate` and/or `runScripts`). It runs in one transaction. The `matrix_updates` row is written only on success.
5. **Ontology changes that do not touch existing data** (a label, a list of components) ship in any version of their minor. They do not move the data version.
6. **Nightlies never carry data changes** (see D2). A data change is first shipped in a beta.
7. **Running a data update is done from the maintenance panel**, after putting Dédalo in maintenance mode and taking a backup. No separate script is run by the operator.

---

## 5. Version constants

The names must say what the value *means*. The code today uses `DEDALO_VERSION_TRIPLE` for the data version and `DEDALO_NEXT_DEV_TRIPLE` for the next release. Neither name says so.

**Proposed names (D6):**

| Current name | Proposed name | Holds | Current value | Rule |
|---|---|---|---|---|
| `DEDALO_VERSION_TRIPLE` | `DEDALO_DATA_VERSION` | The data version, as `[major, medium, minor]` | `[7, 0, 0]` | Moves only when a data-changing release ships. Target: derived from the catalog, not hand-set (D4). |
| `DEDALO_NEXT_DEV_TRIPLE` | `DEDALO_NEXT_RELEASE` | The release the code builds toward, as `[major, medium, minor]` | `[7, 0, 0]` | Hand-set. Moves forward in the post-release commit (§6). Never below the data version. |

**One constant per meaning.** `DEDALO_VERSION` (the string) is removed: it is only `DEDALO_VERSION_TRIPLE.join('.')`, a copy that can drift from the triple. Anything that needs the string calls one helper, `formatVersion(DEDALO_DATA_VERSION)`, which returns `'7.0.0'`. Comparisons use the triple.

Why `NEXT_RELEASE` and not `CODE_NEXT_DEV`: the value is a *release* (`7.0.0`). The `-dev` suffix is the *label* a nightly gets, so putting `DEV` in the constant name would suggest the release is itself a dev build.

**Wire keys do not change.** The browser receives `dedalo_data_version` and `dedalo_version`. The rename is in the server only: the JSON names and the client contract stay as they are, and `dedalo_version` is filled from the helper.

**Scope of the rename**, from a grep of `src`, `scripts`, `deploy`, `test` and `client`:
- `DEDALO_VERSION_TRIPLE` → `DEDALO_DATA_VERSION`: 34 files, 118 lines.
- `DEDALO_VERSION` (string) is removed: 60 files, 219 lines. Many matches are not the constant (for example, a word inside a string), so the change must be done by symbol, not by text search.
- `DEDALO_NEXT_DEV_TRIPLE` → `DEDALO_NEXT_RELEASE`: 23 files, 73 lines.

**Current state is wrong** in one place: the next-release value is `7.0.1` while the next release is `7.0.0`. Nightlies are therefore named `7.0.1-dev` when they should be `7.0.0-dev`.

---

## 6. Release procedure

1. Confirm the catalog has an entry for the target release (`updateData` true or false).
2. Tag the commit (`vX.Y.Z` or `vX.Y.Z-beta.N`).
3. Build the Docker image for that tag, if the tag is a release or a beta.
4. If the release is stable, move `DEDALO_NEXT_RELEASE` to the next patch triple in a follow-up commit.
5. If the release changed data, confirm `DEDALO_DATA_VERSION` matches the catalog entry.
6. Publish the operator notes: which version Docker installs take, and whether Update data is needed.

---

## 7. Scenarios (acceptance)

Each scenario is a test the gates must pass once this spec is signed off.

| # | Situation | Expected |
|---|---|---|
| S1 | Docker `7.0.0-beta.7` → `7.0.0` | Allowed. Same data. |
| S2 | Docker `7.0.0` → `7.0.1` (code-only patch) | Allowed. No Update data. |
| S3 | Docker asked for a `-dev` image | Refused, with a message saying Docker has no nightly images. |
| S4 | Docker `7.0.1` asked for `7.0.0` | Refused as a downgrade. |
| S5 | Tree dev channel `7.0.0-beta.7` takes nightly `7.0.0-dev` | Allowed (forward). |
| S6 | Tree master channel `7.0.0` is offered nightly `7.0.1-dev` | Not offered (per D1, default). |
| S7 | Tree installs `7.1.0`, a minor with data steps | Update data is required before the data version moves. |
| S8 | A patch `7.0.1` declares data steps | Refused by the catalog validator. |
| S9 | A commit tagged `v7.0.1` is built as a nightly | Refused (per D3, default). |
| S10 | Nightly `7.0.0-dev` installed, then `7.0.0` released | Dev install moves to `7.0.0`. Nothing moves back. |

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

## 9. Gates (to be added once signed off)

- Ordering: the comparator matches §3 for every pair in the ordering fixture.
- Install acceptance: a test per row of §3 and per scenario in §7.
- Data: a patch with data steps is refused; a data-changing release has `updateData: true` and a matching `DEDALO_DATA_VERSION`.
- Next release: `DEDALO_NEXT_RELEASE` is never below `DEDALO_DATA_VERSION`.
- No `-dev` image name appears in the Docker pull, build or publish path.

---

## 10. Out of scope

- The internal layout of the update engine, which is covered by its own specs.
- Ontology versioning, which follows `docs/management/updates/updating_ontology.md`.
- Backup and restore.
