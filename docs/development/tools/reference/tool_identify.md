# tool_identify

Curator-facing front end of the object-identification engine: from an object record, it asks which records are most likely to be the same type, and renders the per-criterion reason for every candidate. Its API surface is the already-registered `dd_identify_api` class, called directly; the tool's own `server/index.ts` holds a single action, `cluster`, and exists only because the background tier is reachable only from a tool action.

## What it does / why & when to use it

`tool_identify` opens on a **saved object record** and runs one comparison: the record (the *seed*) against the rest of the corpus the caller may read, under the section's **identification profile**. It renders the ranked candidates with their verdict, score, thumbnail and — always, never behind a toggle — the full per-criterion breakdown that produced the score.

The tool is deliberately thin. All the reasoning (pool query, scoring, access control, thumbnail resolution) happens in the engine's identification subsystem; this tool is a request, a render and a set of honest failure messages.

It **owns no write path**. It does write — an accepted proposal, and the Type link of a promoted group — but every write is `get_instance` + `change_value` on the target record's own component, the same call the record's edit form makes, on the precedent of [tool_cataloging](tool_cataloging.md). No tool-side write endpoint exists, and `dd_identify_api` is four READ actions.

Use it as the reference implementation for a tool that consumes an **existing engine API class** instead of re-wrapping it in tool-local actions — its own server module is one background-only action, not an API surface.

## How it works (server + client)

**Server.** `tools/tool_identify/server/index.ts` holds **exactly one action**, `cluster`, and exists for the BACKGROUND RUNNER rather than for the API surface: comparing a whole pool of records with each other is minutes of work, and the only way onto the background tier is a tool action listed in a module's `backgroundRunnable`. Everything else the tool does is a single-request read on `dd_identify_api`, and gains nothing from a second door.

That is a decision, not an omission. The engine already exposes the identification actions on the normal, gated API (`dd_identify_api`, registered in the dispatch `ACTION_REGISTRY` in `src/core/api/dispatch.ts`), where the dispatcher has already required a session and verified CSRF before any handler runs, and where the request principal is the access gate. A tool-local server module would re-wrap that endpoint and add a second permission surface for nothing. The precedent is `core/search/js/search.js`, which calls `dd_rag_api:semantic_search` the same way, and [tool_cataloging](tool_cataloging.md), which ships no `server/` directory at all.

**Client** (`tools/tool_identify/js/`). Module entry `index.js` re-exports `tool_identify.js` (the instance), whose DOM lives in `render_tool_identify.js` and is mixed in by `wire_tool()`.

| File | Responsibility |
| --- | --- |
| `tool_identify.js` | Lifecycle + every round trip: `init` (resolve the seed), `build` (no-op ddo_map loader — the tool renders no components), `find_matches`, `get_proposals`, `accept_proposal`, `cluster`, `resolve_type_link`, `create_type_record`, `name_type_record`, `attach_members`, `resolve_labels`, `open_record`, `on_close_actions`. |
| `render_tool_identify.js` | The seed view: summary strip, toolbar, notices, proposals, candidate list, per-criterion breakdown, thumbnails. Exports `render_decline` + `record_title` (one decline voice, one title resolver for the whole tool). |
| `render_tool_identify_clusters.js` | The batch view: groups, their consensus/shape/links, and TYPE PROMOTION (choose → review → confirm → per-member outcomes + retry). |
| `css/tool_identify.less` | Authoring source; `bun run css:build` compiles the committed `.css`/`.css.map` twins. |

Load-bearing client details:

- **The seed comes from the caller**, not from `self.section_tipo` — a tool's own `section_tipo` is the tools registry section, not the object's. `init` reads `caller.section_id`, falling back to `caller.section_id_selected`. No seed is not an error state: it is reported as the same `missing_seed` decline the server uses.
- **`build` overrides the ddo_map loader with a no-op.** The tool renders no component instances, so the generic loader would rebuild the caller's components for nothing.
- **Record titles** come from the existing batched, permission-checked `get_section_terms` endpoint via `fetch_section_terms` (one request for the seed plus the whole page of candidates). A locator whose term the server does not resolve keeps its locator as the visible title — honest, and better than a blank row.
- **`open_record`** uses the client's own deep-link grammar plus `open_window`, with `session_save:false` (and therefore `menu:false`): the tool is a modal over the seed, so navigating the page underneath would destroy the record the comparison is about.
- **`on_close_actions` is defined**, which makes `view_modal` skip its default teardown (caller refresh + component activate). The caller is refreshed only when something was actually written (`accepted + promoted > 0`) — a pure comparison leaves nothing to re-read.
- **The caller's SQO is cloned, never mutated** (`cluster`): the pool for a grouping run is the curator's live filter with `limit`/`offset` zeroed, and narrowing their own list would leave them looking at something they did not build.
- A `save` event on the **seed** record marks the current answer stale (the *Find matches* button is highlighted) instead of silently leaving a ranking computed from values that may have changed.

## Actions & options

This tool declares **one** API action of its own:

| `apiActions` | Permission | Value |
| --- | --- | --- |
| `cluster` | `section_list`, minLevel 1 on every target section | Group a pool of records (`{section_tipo, sqo?, records?, cap, min_cluster_size, lang?, …}`). READ level, because clustering only reads — the write half is the ordinary component save from the client. Also `backgroundRunnable`. `lang` is the data language the criteria are compared in: omitted, the request's data language; sent, it must be a language code. Either way it must be one of the installation's data languages (`DEDALO_PROJECTS_DEFAULT_LANGS`, `DEDALO_DATA_LANG_DEFAULT`, their equivalences, `lg-nolan`) — the same rule `change_lang` applies to the session's data language — or the run is refused with `request.invalid_options` before anything is read. |

It calls the engine's own class directly, through `data_manager.request` (`use_worker: false`, `prevent_lock: true`):

| Endpoint · action | Request | Answer |
| --- | --- | --- |
| `dd_identify_api:find_matches` | `{ section_tipo, section_id, limit }` — limit clamped server-side to `[1,50]`, default 20 | `{ seed, profile, results, more_available, blind_criteria, restricted_criteria }` |
| `dd_identify_api:get_proposals` | `{ section_tipo, section_id, source }` — the vision source is opt-in per run, and requires the caller's profile to authorize `tool_identify` (a model call is a spend; refused `tool.not_authorized` before any model runs) | `{ seed, profile, sources, proposals }` |
| `dd_identify_api:resolve_type_link` | `{ section_tipo, records? }` — the cluster's members, capped at 300 | `{ type_section, links, existing_types, members_surveyed }` |

Response shape (snake_case at the API boundary, converted there from the subsystem's camelCase):

```json
{
  "seed":    { "section_tipo": "numisdata4", "section_id": 512, "thumb_url": "/media/image/thumb/0/numisdata21_numisdata4_512.jpg" },
  "profile": { "id": "coin_types", "label": "Coin identification" },
  "results": [
    {
      "section_tipo": "numisdata4",
      "section_id": 998,
      "thumb_url": null,              // no preview component, or no derivative on disk
      "score": 0.82,                  // share of the ACHIEVABLE identifying weight
      "verdict": "candidate",         // same_type | candidate | weak
      "outcomes": [                   // never omitted — one row per non-ignored criterion
        { "criterion_id": "obverse_legend", "label": "Type › Obverse legend",
          "agreed": true, "weight": 6, "detail": "both 'ATHENA'",
          "required": true },         // the GATE: weight declared, NOT in the ratio
        { "criterion_id": "weight_g", "label": "Weight (g)",
          "agreed": null, "weight": 0, "detail": "not recorded on one side" },
        { "criterion_id": "findspot", "label": "Findspot",
          "agreed": null, "weight": 2, "detail": "not readable by this caller",
          "restricted": true }        // no grant: not compared, not quoted
      ]
    }
  ],
  "more_available": false,            // a FLAG, never a count
  "blind_criteria": ["mint"],         // criteria the SEED states nothing for
  "restricted_criteria": ["findspot"] // criteria THIS CALLER may not read
}
```

Six fields carry contracts the client must not flatten:

- **`outcomes[].weight` is the criterion's DECLARED weight, not always its contribution.** It is `0` for a `descriptive` criterion (shown, never scored) and the authored number otherwise — including for a `required` one, which contributes NOTHING to the ratio because it gated the candidate in instead (`IDENTIFY_SPEC` §5). Every scored candidate already agrees on a required criterion, so counting its weight would add the same constant to every row and push all of them toward `same_type`.
- **`outcomes[].required` marks that gate**, and is present only when true. It exists because the weight alone cannot be read correctly: a gate either looks like it contributed points it did not, or — if someone zeroed the weight to "signal" the exclusion — like the weakest, purely descriptive criterion in the profile, when it is the one thing every candidate on screen had to agree on. **Never zero a weight to say this**; the marker says it. The render gives it a third state: **gate** (required, not part of the score) / **weight n** / **descriptive** (shown, not scored), plus a sentence under the row whenever the gate actually ran (a required criterion the seed states nothing for gated nobody, `IDENTIFY_SPEC` §5).
- **`outcomes[].agreed` is a tri-state**: `true` agreed, `false` differed, **`null` = neither side records it**. Null is absence, not disagreement — the engine already excluded it from the achievable weight, so it did not lower the score, and the render must not paint it as a failure. `render_tool_identify.js` maps the states to `agreed` / `differed` / `unrecorded` classes, the third muted and dashed, with an explicit sentence under every such row.
- **`outcomes[].restricted`** (present only when true) is the fourth row state, and it is NOT the third one: the caller has no dd774 grant on the criterion's components, so it was neither compared nor quoted — `agreed` is `null` and `detail` is a CONSTANT string, never a value. Rendered with its own hue and a DOTTED rule (unrecorded is dashed) and its own sentence, because "you may not read this field" and "nobody recorded this field" are claims about different things: a curator who reads the first as the second concludes their catalogue is empty where it is only closed to them.
- **`blind_criteria`** are criteria the seed itself has no value for. The tool renders them whenever the array is non-empty, recovering human labels from any candidate's outcomes (every non-ignored criterion appears in every breakdown) and falling back to the raw id when there are no candidates at all.
- **`restricted_criteria`** are the criteria this caller has no grant on, for the run as a whole — so **the scores in the answer are partial**, computed over the rest, and a colleague with more permissions sees a different number for the same pair. Rendered as its own notice, never merged with `blind_criteria`, for the reason above. It is not an existence oracle: it names the caller's own grants (uniform across the section, derivable from their profile), never anything a record holds.
- **`more_available`** is a boolean, because the pool query fetches `cap + 2` rows purely to answer "is there more?" — one spare row for the probe, one for the seed, which matches its own filter and is dropped from its own results. Rendering it as a count would claim a number nobody measured.

Declines arrive as **HTTP 200 with `result:false`** and a single stable code in `errors`, never as a 500. The tool maps each to its own message and tone:

| Code | Meaning | Rendered as |
| --- | --- | --- |
| `no_profile` | The section declares no identification profile | information — a section that does not do identification is a normal section |
| `invalid_profile` | The descriptor exists but is malformed | failure, **with the parser's exact message printed verbatim** |
| `forbidden` | The caller may not read the section or the record | information |
| `missing_seed` | No usable `section_tipo` / `section_id` | information |
| `no_type_section` | The profile declares no Type section: this collection has no typology to promote a group into | information, **with the server's sentence** — and the promote control is not rendered at all |
| `no_link_component` | No criterion reaches the Type section in one hop, so the component that links a record to its Type cannot be derived | failure, with the server's sentence; the engine refuses to guess which component it is |
| *(anything else, or a transport error)* | — | generic failure with the detail shown |

The section read grant is checked **before** the profile is loaded, so the decline codes cannot become an oracle for which sections have a descriptor.

## Type promotion (`resolve_type_link` + the ordinary save)

Promotion turns a cluster into a citable record: a canonical **Type** every member links to (`engineering/IDENTIFY_SPEC.md` §8.4). The division of labour is the point.

**The server answers three questions and writes nothing** (`buildResolveTypeLink` in `src/core/api/handlers/dd_identify_api.ts`):

1. *Is promotion meaningful here?* `typeSectionTipo === null` → the `no_type_section` decline above.
2. *Which component is the Type link?* `typeLinkCandidates(profile)` — the entry component of any criterion whose **first** hop lands in `typeSectionTipo`. This is literally the same function `identify_by_image` uses to name a candidate's `types`, so the feature that WRITES the link cannot disagree with the feature that reports it. Only the first hop qualifies: the hop component of step *i* is stored on the record of step *i−1*, so a Type two hops out is not a component of the object at all. Zero candidates → `no_link_component` (refuse, never a plausible portal); several → the panel asks the curator, it does not choose.
3. *What may this caller do?* Write grants on the link component (`writable` + a `reason`: `ok` / `forbidden_component` / `unsupported_component_model`), on the Type section (`can_create`), and on the Type's label component — which is `writable:false` when the section's main term is a relation, because a typed string cannot be composed into a thesaurus link.

It also **surveys** the members it is given (`records`, capped at 300) and reports the Types they already carry with a `member_count`, so "attach to the existing Type" needs no record picker. Two gates per value: the component grant on the member, then the record-scope gate on the Type before its label is quoted.

**The client writes, through the ordinary save only** (`render_tool_identify_clusters.js` + `tool_identify.js`):

| Step | Call |
| --- | --- |
| Mint a Type | `section.create_section()` on a section instance built with `id_variant:'tool_identify_promote'` (so it can never be the curator's own live instance) |
| Name it | `get_instance` + `change_value` on the Type section's label component — only when the server reported it writable and literal |
| Attach each member | `get_instance` + `change_value` on that member's link component, with `from_component_tipo` in the locator (the server partitions a record's locators per component with it) |

`attach_members` returns **one outcome per member** — `attached` / `already` (it was linked before we arrived; nothing written) / `failed` with the server's message — and one member's failure never stops the rest. The view renders every outcome, counts the three, and offers a retry that re-runs **only** the failures. Confirmation is a separate step that states the target, the component and the number of records before anything is written.

## The profile descriptor it depends on

The tool renders whatever the profile decides; it has no configuration of its own (no `tool_config`, no `ddo_map`). The profile lives on the **section's ontology node**, under `properties.identify`, and is parsed strictly by the engine (`src/core/identify/profile.ts`):

```json
{
  "id": "coin_types",
  "label": "Coin identification",
  "typeSectionTipo": "numisdata3",
  "previewComponent": "numisdata21",
  "thresholds": { "sameType": 0.85, "candidate": 0.5 },
  "criteria": [
    { "id": "obverse_legend", "label": "Type › Obverse legend",
      "path": [ { "section_tipo": "numisdata4", "component_tipo": "numisdata161" },
                { "section_tipo": "numisdata3", "component_tipo": "numisdata40"  } ],
      "role": "identifying", "mode": "same_locator", "weight": 3, "required": true },
    { "id": "weight_g", "label": "Weight (g)",
      "path": [ { "section_tipo": "numisdata4", "component_tipo": "numisdata22" } ],
      "role": "descriptive", "mode": "numeric_tolerance", "tolerance": 0.15 }
  ]
}
```

What matters to a tool developer:

- **A criterion is a search path.** `path` is an SQO `path` — its steps are snake_case because they reach the search engine unmodified — so a criterion can cross records (*Coin → Type → Obverse legend*), and the field picker that produces one is the search panel's own recursive component list.
- **The descriptor is refused loudly, never degraded.** An unknown key, a dangling path hop, a component declared under a section that does not hold it, thresholds that can never be satisfied — all throw, and the message reaches the panel as `invalid_profile`. A criterion that quietly stopped contributing would still produce a confident score from fewer features than were configured, and ranked output hides that completely.
- **`previewComponent`** names the media component whose *thumb* derivative illustrates a record. It is what makes the thumbnails possible: the candidate's section is arbitrary, so the client cannot know which media component stands for the object, and only the profile can say. It is validated at parse time to exist, to be a media component, to have a thumb tier (so `component_svg` is refused) and to belong to one of the profile's sections.
- **Absent is not malformed.** A section with no `properties.identify` yields `no_profile`, which the tool renders as information.

Resolved profiles are cached per section and dropped on any ontology write, so a curator's fix takes effect on the next request.

### Thumbnails are resolved server-side

`thumb_url` is built by the engine (`src/core/identify/preview.ts`) for the seed and every scored candidate, using the media subsystem's own path grammar rather than a concatenated string. Two properties the client relies on:

1. **A URL is only returned when the derivative exists on disk.** The pure URL builder would happily name an ungenerated thumb, which renders as a broken image in every row.
2. **It resolves pictures only for records the engine already gated** — the seed (a denied read raises) and the ACL-filtered candidates — and makes no access decision of its own.

`null` is therefore the normal, expected value, and `render_tool_identify.js` renders it as a neutral placeholder. The same placeholder replaces an `<img>` whose load fails, since media URLs are additionally gated by the web server.

## How it is registered & surfaced

`tools/tool_identify/register.json` is in the hand-authorable **authoring format** (see [register.json reference](../register_json.md)), converted at registration:

```json
{
    "name": "tool_identify",
    "version": "1.0.0",
    "label": { "lg-eng": "Identify", "lg-spa": "Identificar" },
    "developer": "Dédalo team",
    "affected_models": ["section"],
    "show_in_inspector": true,
    "show_in_component": false,
    "active": true,
    "properties": { "open_as": "modal" },
    "labels": [
        { "lang": "lg-eng", "name": "identify_unrecorded", "value": "Not recorded" }
    ]
}
```

The choices, and why:

| Field | Value | Why |
| --- | --- | --- |
| `affected_models` | `["section"]` | The tool is about a RECORD, so it attaches to the section, not to any single component. |
| `show_in_inspector` | `true` | It acts on the selected record; the inspector is where record-scoped tools surface. |
| `show_in_component` | `false` | There is no per-field version of the question. |
| `affected_tipos` | *(absent)* | Nothing restricts it to one collection: whether it can answer is decided by the presence of a profile, at request time — not by a hardcoded tipo list. |
| `properties.open_as` | `"modal"` | It runs over the seed record and must not navigate away from it. |
| `labels` | inline, per language | Every string the render can show, including the long explanatory ones (`identify_unrecorded_note`, `identify_restricted_note`, `identify_gate_note`, `identify_blind_criteria`, `identify_restricted_criteria`, `identify_more_available`, `identify_no_profile`), lives in the register rather than in the JS. The fallbacks in the JS are English defaults, not the source of truth. |

No `require_translatable`, no `tool_config`, no `ddo_map`: there is nothing to configure per element. A section either has an identification profile or gets the `no_profile` answer.

## Examples

The whole server contract of this tool, from `tool_identify.js`:

```js
const api_response = await data_manager.request({
    use_worker : false,
    body       : {
        dd_api       : 'dd_identify_api',
        action       : 'find_matches',
        prevent_lock : true,
        options      : {
            section_tipo : self.seed.section_tipo,
            section_id   : self.seed.section_id,
            limit        : self.limit
        }
    }
})

const result = api_response ? api_response.result : null
if (!result || typeof result!=='object') {
    // a DECLINE (HTTP 200, result:false) or an unusable envelope — keep the
    // code and the server's own message; they are the answer, not a failure
    const errors = (api_response && Array.isArray(api_response.errors)) ? api_response.errors : []
    self.decline = { code : errors[0] || 'failed', msg : api_response ? api_response.msg : null }
    return false
}
self.report = result
```

And the tri-state that the breakdown is built on, from `render_tool_identify.js`:

```js
// agreed: true | false | null. null is ABSENCE (neither side records it),
// never a failure — it did not lower the score.
const state = (outcome.agreed===true)
    ? 'agreed'
    : (outcome.agreed===false)
        ? 'differed'
        : 'unrecorded'
```

## Related

- [Identify (user guide)](../../../using/tools/using_identify.md) — what the panel answers and how a curator reads a verdict, a score and a "not recorded" row.
- [Creating new tools](../creating_tools.md) · [Server contract](../server_contract.md) — the tool model, and the minimal-server-module case this tool is an instance of.
- [tool_cataloging](tool_cataloging.md) — the UI-only tool that drives already-gated endpoints without owning any server module at all.
- [tool_time_machine](tool_time_machine.md) — where a curator goes when a comparison changed because a value did.
- Source: `tools/tool_identify/register.json`, `tools/tool_identify/server/index.ts` (the one `cluster` action), `tools/tool_identify/js/{index,tool_identify,render_tool_identify,render_tool_identify_clusters}.js`, `tools/tool_identify/css/tool_identify.less`; engine side `src/core/identify/`, `src/ai/identify/` and `src/core/api/handlers/dd_identify_api.ts`.
