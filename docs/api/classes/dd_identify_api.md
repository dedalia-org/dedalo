# dd_identify_api

> See also: [JSON API v1](../dedalo_api_v1.md) · [tool_identify](../../development/tools/reference/tool_identify.md) · [Semantic search / RAG](../../administration/ai/rag.md) · [dispatch](dispatch.md)

Object identification: which records share this one's identifying features, what a photograph most resembles, what a record's empty criteria probably should say, and where a cluster could be promoted into a canonical Type.

Registered actions (`src/core/api/handlers/dd_identify_api.ts`): `find_matches`, `identify_by_image`, `get_proposals`, `resolve_type_link`.

## How to call

- POST JSON to `/api/v1/json` with `dd_api: "dd_identify_api"` and `action: "<method>"`.
- **All parameters ride in `rqo.options`** — this class reads nothing from `rqo.source`.

## Notes

- Every action requires a **session** and is **CSRF-gated** by the dispatcher.
- **All four are READS.** Nothing here writes. Confirming a proposal, or attaching a member to a Type, is the ordinary component save the record form already issues — there is deliberately no confirm/attach endpoint, because a second write path into a portal would have to re-implement the audit, the observers and the permission re-check the first one does.
- Identification is driven by the section's **identification profile** (`properties.identify`). A criterion is an [SQO](../sqo.md) path, not a thesaurus. A section without a profile is a normal state of the collection, so it is a **clean decline**, never a 500.
- **Order is load-bearing.** The section read grant is checked *before* the profile is loaded, so the decline codes can never be used to learn whether a section the caller cannot open has an identification descriptor.
- Results are **ACL-gated inside the engine** — the pool query carries the principal, and every quoted label of a linked record is re-gated per component and per record scope. Denials are silent: a "3 hidden" count would be an existence oracle.
- `limit` is clamped to `[1, 50]`; anything unusable falls back to **20**.
- Envelope: **v2**. Success is `{ ok: true, request_id, data }`; a decline is `{ ok: false, request_id, error: { code, … } }`. Codes in the `identify.*` family marked *public* below carry the engine's own explanatory sentence to the curator.

!!! info "About the examples on this page"
    The requests below are **shape only**. No section of the `monedaiberica` reference install this manual is written against declares a `properties.identify` profile today, so `numisdata4` — a real section there — is used as a stand-in for the coordinates. Substitute your own profiled section; against a section without a profile every action here declines with `identify.no_profile`.

### Decline codes

| code | status | meaning |
| --- | --- | --- |
| `identify.missing_seed` | 400 | `section_tipo` / `section_id` missing or unusable. |
| `identify.missing_section` | 400 | `section_tipo` missing or not a valid tipo (`resolve_type_link`). |
| `identify.no_profile` | 400 | the section declares no identification profile. |
| `identify.invalid_profile` | 400 | the profile is malformed — **public**, so the parser's exact sentence reaches the curator. |
| `identify.invalid_source` | 400 | an unknown proposal source name — **public**. |
| `identify.rag_disabled` / `identify.media_disabled` | 503 | the RAG switch, or the RAG **media** switch, is off. |
| `identify.missing_image` / `identify.invalid_image` / `identify.image_too_large` | 400 | no image, undecodable bytes, or over the 8 MB decoded ceiling. |
| `identify.egress_forbidden` | 403 | the configured provider would send object images off this host under a local-only policy — **public**. |
| `identify.provider_unavailable` / `identify.embed_failed` | 503 | the multimodal provider could not be built, or returned no vector — **public**, retryable. |
| `identify.empty_index` | 503 | nothing has been indexed to compare against — **public**. |
| `identify.no_type_section` | 400 | the profile declares no Type section, so there is nothing to promote into — **public**. |
| `identify.no_link_component` | 400 | no criterion reaches the Type section in one hop, so the link component cannot be derived — **public**. |
| `perm.denied` | 403 | the caller may not read the section, the seed, or (for a scoped request) any of the sections asked for. |

## find_matches

### Purpose

"What else is like **this record**?" — structural agreement over the section's profile, with the reason for every candidate.

### Accepts

- `options`: object (required)
    - `section_tipo`: string (required) — the seed's section.
    - `section_id`: int (required) — the seed record.
    - `limit`: int (optional, `[1, 50]`, default 20).

### Returns

`{ ok: true, data: { seed, profile, results, more_available, blind_criteria, restricted_criteria } }`.

- `seed` — `{ section_tipo, section_id, thumb_url }`. `thumb_url` is `null` unless the profile declares a preview component *and* its thumb exists on disk; never an absent key, never a URL the client cannot render.
- `profile` — `{ id, label }`.
- `results[]` — `{ section_tipo, section_id, thumb_url, score, verdict, outcomes[] }`. Each outcome is `{ criterion_id, label, agreed, weight, detail }`, plus two markers emitted only when true:
    - `restricted: true` — this caller has no grant on the criterion, so it was neither compared nor quoted and the score was computed **without** it.
    - `required: true` — the criterion is the profile's gate, so its declared weight is deliberately out of the ratio.
- `more_available` — a flag (not a count): the pool cap stopped the run before the pool ran out.
- `blind_criteria` — criteria the **seed** records no value for, so they discriminated nothing.
- `restricted_criteria` — criteria **this caller** may not read, so the scores in this answer are partial.

!!! warning
    `blind_criteria` and `restricted_criteria` are claims about different things — "nobody recorded it" versus "you may not see it". A UI that renders them the same tells a restricted curator their catalogue is empty where it is only closed to them.

### Example request

```json
{
  "dd_api": "dd_identify_api",
  "action": "find_matches",
  "options": { "section_tipo": "numisdata4", "section_id": 1, "limit": 20 }
}
```

## identify_by_image

### Purpose

"What **is** this?" for material with no record yet: a photograph the curator just took, matched against the image index.

### Accepts

- `options`: object (required)
    - `image`: string (required) — base64, or a `data:` URL. The declared MIME is never trusted: the decoded bytes are sniffed by magic bytes and refused unless they really are a raster format the encoder reads. The base64 **string length** is checked before decoding, so an oversized upload never costs the memory.
    - `section_tipo`: string | array (optional) — scope, narrowed to the sections this caller may open.
    - `limit`: int (optional, `[1, 50]`, default 20).

### Returns

`{ ok: true, data: { model, scope, results, warnings } }`.

- `model` — the image-index partition that was searched. Two models are two indexes.
- `scope` — the sections actually searched; `[]` means the whole image index.
- `results[]` — `{ section_tipo, section_id, label, similarity, view, thumb_url, media_tipo, context, types[] }`. `similarity` is cosine, rounded to four decimals. `types[]` is the Type records the candidate is linked to (`{ section_tipo, section_id, label }`), derived from the candidate section's own profile.
- `warnings[]` — legible reasons something could not be resolved (a malformed profile on one of the answering sections, for instance). Empty on a clean run, and never a substitute for a decline.

!!! danger
    An `ok` answer with **zero results** means the corpus was searched and nothing came close. `identify.empty_index` means nothing has ever been indexed. Collapsing the two lets a curator read "we have nothing like this object" off an installation that simply never ran the image indexer.

!!! warning "An external encoder needs the tool grant"
    When the configured multimodal encoder is **external** (the photograph leaves the host), the caller's profile must authorize `tool_identify`: without it the answer is `tool.not_authorized` (403), before the image is embedded. A local encoder spends nothing and needs no grant. Global admins are not exempt.

!!! note
    This path is read-only and leaves nothing behind: the bytes live in memory for one request and are dropped. The image is a query, not a document — indexing it would put an unaccessioned object into the corpus that answers everybody else's searches.

### Example request

```json
{
  "dd_api": "dd_identify_api",
  "action": "identify_by_image",
  "options": {
    "image": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA…",
    "section_tipo": "numisdata4",
    "limit": 10
  }
}
```

## get_proposals

### Purpose

"What **should** this record say?" — proposed values for the criteria a record leaves empty. The read half of "AI proposes, human confirms".

### Accepts

- `options`: object (required)
    - `section_tipo`: string (required), `section_id`: int (required) — the seed.
    - `source`: string | array (optional) — `neighbour_vote` (the default), `vision_model`, or `all`. Aliases: `vote`, `neighbours`/`neighbors`, `vision`, `both`.
    - `limit`: int (optional, `[1, 50]`, default 20) — neighbours considered.
    - `model_id`: string (optional) — the vision model to use.

!!! warning
        The **vision source is opt-in, always**. It calls a paid model and, depending on the deployment, sends the record's photograph off the host — never a side effect of opening a panel. Asking for it (`vision` / `vision_model` / `all`) also requires the caller's profile to authorize `tool_identify`: without the grant the whole request is refused as `tool.not_authorized` (403) before the profile is loaded or any model is called. An unknown source name is **refused**, not narrowed to the default: a client that misspells `vision` and silently gets the vote would report a corpus consensus as a model's opinion.

### Returns

`{ ok: true, data: { seed, profile, sources, proposals } }`.

- `sources[]` — one entry per source, requested or not: `{ source, requested, ran, declined, … }`. An unrequested source rides along with `declined: { reason: "not_requested", detail }`, so "no vision proposals" can never be misread as "the model found nothing". A source that threw reports `declined: { reason: "source_failed", detail }` — the other source's proposals still travel. The vote entry adds `neighbour_source`, `neighbour_source_reason`, `neighbours_considered`, `skipped`; the vision entry adds `model`, `image`, `skipped`, `discarded` (answers the model gave that were **not** in the vocabulary it was shown — hallucination made visible).
- `proposals[]` — in the curator's own profile order, the vote before the model when both answered the same criterion. Every proposal carries its `source`, a `provenance` object whose **shape differs per source** (citing the neighbour records, versus naming the model, its egress class, its stated reason and the photograph it read), and a `target`.

#### The `target` of a proposal

A criterion is an SQO **path**, and a multi-hop path's value does not live on the seed at all — it lives on the record the first hop reaches. Writing it to the seed would put a curator's confirmation in the wrong place, silently. So every proposal states where it would land and, when it cannot land here, why:

| `reason` | meaning |
| --- | --- |
| `ok` | writable here: a single-hop criterion on a component this caller may edit. |
| `multi_hop` | the value lives on a linked record; the ACL-gated linked records are named so the curator can open them. |
| `forbidden_component` | this caller may read the record but not write the component. |
| `unsupported_value_kind` | a date range is not one component-dialect value this flow can honestly compose. |
| `foreign_section` | the target is not a component of the seed's section. |

### Example request

```json
{
  "dd_api": "dd_identify_api",
  "action": "get_proposals",
  "options": { "section_tipo": "numisdata4", "section_id": 1, "source": "all" }
}
```

## resolve_type_link

### Purpose

"Where would this cluster be **promoted** to?" — the Type section, the component that holds the link, what this caller may write, and the Types the cluster's members already carry.

### Accepts

- `options`: object (required)
    - `section_tipo`: string (required) — the members' section.
    - `records`: array (optional) — the cluster's members, `[{ section_tipo, section_id }]`. Entries naming another section are dropped; duplicates collapse; the survey stops at **300** records.
    - `check_type_id`: int (optional; a numeric string is accepted) — a hand-typed Type id to verify before anything is attached to it.

### Returns

`{ ok: true, data: { section_tipo, profile, type_section, links, existing_types, members_surveyed, type_record } }`.

- `type_section` — `{ section_tipo, can_create, label_component }`: the Type section, whether this caller may mint a new Type there, and the component that names one (`{ section_tipo, component_tipo, component_model, kind, writable }` — `kind: "relation"` means the Type's main term is a thesaurus term, so the panel must offer the record rather than compose a typed string).
- `links[]` — one per candidate link component: `{ section_tipo, component_tipo, component_model, writable, reason, detail, revealed_by[] }`. `revealed_by` names the criteria that revealed it. **More than one link is a real answer** (two criteria reaching the typology through different components) and the panel must ask rather than pick.
- `existing_types[]` — `{ section_tipo, section_id, label, member_count }`, the Types the surveyed members already link to, commonest first (ties break on id). One member counts once per Type however many components link it to it. This is what makes "attach to the existing Type" the one-click common case without inventing a record picker.
- `members_surveyed` — how many of the named members could actually be read.
- `type_record` — `null` unless `check_type_id` was asked; otherwise `{ section_tipo, section_id, exists, label, reason, detail }` with `reason` one of `ok`, `invalid_id`, `not_found`. Only `ok` may arm an attach: the one place this flow takes a locator from a keyboard is the one place a typo becomes thirty locators on a record that does not exist, and no downstream gate catches that for a portal.

!!! note
    `not_found` covers both "there is no such record" and "there is, and you may not read it" — deliberately one answer, because splitting them turns the check into an existence oracle for records outside the caller's projects filter.

!!! note
    The link component is **derived from the profile, never guessed**. A section usually has several relation components aimed at the Type section, and writing a curator's confirmation into the wrong one is invisible and permanent — so when no criterion reveals it, the action declines with `identify.no_link_component` instead of picking the plausible portal.

### Example request

```json
{
  "dd_api": "dd_identify_api",
  "action": "resolve_type_link",
  "options": {
    "section_tipo": "numisdata4",
    "records": [
      { "section_tipo": "numisdata4", "section_id": 1 },
      { "section_tipo": "numisdata4", "section_id": 2 }
    ]
  }
}
```
