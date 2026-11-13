# External record services

> See also: [component_external](../components/component_external.md) · [services](services.md) (the *other* meaning of the word) · [Sections](../sections/index.md) · [request_config](../request_config.md) · [Configuration](../../config/config.md)

An **external record service** is a third party whose records Dédalo shows
inside a section without copying them — a bibliographic catalogue, an authority
file, a gazetteer. It is a *server-side* subsystem: the engine fetches a remote
record at read time and renders selected fields of it. Do not confuse it with a
[service](services.md), which in Dédalo is an unrelated, pre-existing concept:
a reusable **client-side** interface module (upload, rich-text editing,
autocomplete) with no ontology node and no outbound traffic of its own. When
this manual says *external service* it always means the subsystem described
here.

This page is the cataloguer's guide: how to connect a service end to end. It is
worked through **Zenon**, the German Archaeological Institute's bibliographic
catalogue, which is the live case on the development install
(`monedaiberica`) — the `zenon*` tipos below are that install's real nodes, so
expect different numbers on yours.

## What you get, and what you do not

An external field behaves like a read-only literal: it shows in edit, list and
Time Machine views, it can be a list column and it exports. What it never does
is **store**:

- there is no record in the local database for an external record — the
  section's `section_id` **is** the remote identifier;
- nothing is ever written back to the third party, and nothing the third party
  returns is ever written into a local record;
- the value is re-derived on every read, so it is always the remote system's
  current answer.

!!! warning "The identifier is a string, and its leading zeros matter"
    Zenon identifiers look like `"001338683"`. That is the `section_id` of the
    external record, verbatim. Treat it as text everywhere — in a locator, in
    an import file, in a URL you paste. Dropping the padding asks the service
    for a different record.

## The four pieces

Connecting a service is four declarations. Three are ontology, one is the
install's configuration file, and all four are required.

### 1. A section for the remote records

The remote records need somewhere to be addressed and displayed. Create an
ordinary section — on this install `zenon1` — and give it the children that
describe one remote record:

```
zenon1    section              ← carries api_config
└ zenon2    section_group
  ├ zenon3    component_external   (identifier)
  ├ zenon4    component_external   (title)
  ├ zenon5    component_external   (authors)
  ├ zenon6    component_external   (publication dates)
  ├ zenon9    component_external   (record page)
  ├ zenon10   component_external   (container title)
  └ zenon11   component_external   (physical description)
  zenon7    component_filter
  zenon8    section_list         relations [zenon3, zenon4, zenon5, zenon6]
```

`zenon1` is a **real** section, not a virtual one: it declares no `relations`
pointing at another section's node. Its own children are the display
definition, and `zenon8` is the column set a list view uses.

### 2. The connection — `api_config` on the SECTION node

```json
{
    "api_config": {
        "entity"        : "zenon",
        "api_url"       : "https://zenon.dainst.org/api/v1/record",
        "api_url_search": "https://zenon.dainst.org/api/v1/search",
        "ui_base_url"   : "https://zenon.dainst.org/Record/",
        "response_map"  : [
            { "local": "ar_records", "remote": "records" },
            { "local": "msg",        "remote": "status"  }
        ]
    }
}
```

| Key | Meaning |
| --- | --- |
| `entity` | Which service adapter handles this section. It must match a registered adapter name exactly; an unknown name is a loud error, never an empty field. |
| `api_url` | The per-record endpoint the **server** calls. Its host must be allowed in the install's configuration (see step 4). |
| `api_url_search` | The search endpoint, when the service has one. Optional. |
| `ui_base_url` | The human-facing page for a record, used to build a link a curator can click. It is opened by the **browser**, so it must be an `http`/`https` address. |
| `response_map` | Local role → remote payload key. The entry whose `local` is `ar_records` names the array of records in the response. |

!!! danger "Never put a credential in `api_config`"
    The ontology is editable data: anyone who can catalogue can read and change
    it. Any key that looks like a credential (`api_key`, `token`, `password`,
    `authorization`, …) is **stripped and reported** rather than used — and
    stripped again before anything reaches a browser. A service credential
    belongs in the install's private environment file, under the key the
    adapter declares. See [Configuration](../../config/config.md).

### 3. The field mapping — `fields_map` on each component node

Each `component_external` maps exactly one remote field. Title (`zenon4`):

```json
{
    "fields_map": [
        { "local": "dato", "remote": "title" }
    ]
}
```

Authors (`zenon5`), using a transform the adapter implements:

```json
{
    "fields_map": [
        { "local": "dato", "remote": "authors", "format": "zenon_authors" }
    ]
}
```

- `local` — only rows whose value is `dato` supply the component's value.
- `remote` — a **path** into the remote record. A plain key (`title`) is the
  common case; a nested one is written with dots and indexes
  (`labels.en.value`, `items[0].body.value`), which is how a service with a
  nested payload is mapped without any code.
- `format` *(optional)* — the name of a transform the adapter provides. For
  Zenon: `array_values` (joins a list with ` | `, dropping empty elements) and
  `zenon_authors` (flattens the authors object). A name the adapter does
  **not** implement is refused as a cataloguing error — it is never passed
  through raw. A transform refuses what it cannot render, too: point
  `array_values` at a field of objects and the items are counted as dropped,
  never stringified. A value with no visible text after formatting produces
  no entry: it is a missing value, not a degraded one.

With no `format`, strings, numbers and booleans are used as they are and a list
fans out into several entries. An **object** with no format is refused and
counted: it has no single correct text form, and guessing one writes rubbish
into a heritage record.

### 4. Allow the host

Nothing leaves the server until the institution says so. In the install's
private environment file:

```bash
DEDALO_EXTERNAL_ENABLED=true
DEDALO_EXTERNAL_ALLOWED_HOSTS=zenon.dainst.org
```

!!! warning "An empty allowlist refuses everything"
    `DEDALO_EXTERNAL_ALLOWED_HOSTS` is empty by default, and empty means **no
    outbound request is made at all**. The list is not a narrowing of an open
    door — it *is* the door. Until a host is named there, every external field
    reports `misconfigured` and nothing is contacted.

    That is deliberate: the address a request goes to is assembled from the
    ontology, so without an operator-held allowlist an ontology edit alone
    would be enough to make the server fetch from anywhere, including inside
    your own network.

    Every other knob — timeout, response size, concurrency, cache age, retries,
    the circuit-breaker cooldown and the two value ceilings — is documented in
    [Configuration](../../config/config.md) under *external*.

## Pointing a record at a remote record

Steps 1–4 make an external section resolvable. To use it from your own
records, a relation component in your section adds a second
[request_config](../request_config.md) item naming the service. On this install
`rsc368` (a `component_autocomplete`) does exactly that:

```json
{
    "api_engine": "zenon",
    "sqo": { "section_tipo": [ { "value": ["zenon1"], "source": "section" } ] },
    "show": {
        "ddo_map": [
            { "tipo": "zenon5", "parent": "self", "fields_map": true, "section_tipo": "zenon1" },
            { "tipo": "zenon6", "parent": "self", "fields_map": true, "section_tipo": "zenon1" },
            { "tipo": "zenon3", "parent": "self", "fields_map": true, "section_tipo": "zenon1" },
            { "tipo": "zenon4", "parent": "self", "fields_map": true, "section_tipo": "zenon1" }
        ],
        "fields_separator": " | "
    }
}
```

Points worth knowing:

- **Every config item contributes.** A component may declare a normal Dédalo
  item *and* an external one; both resolve. Which children a given stored
  locator shows is decided by that locator's own `section_tipo`, so a locator
  pointing at `zenon1` renders the Zenon children and one pointing at a local
  section renders the local ones.
- `"fields_map": true` on a child means *use that node's own `fields_map`*. It
  is a request to look the mapping up, not a value.
- The component that carries the locator can be any relation component. On this
  install the five nodes declaring an external engine span four models —
  `rsc368` and `numisdata162` (autocomplete), `rsc1285`, `tchi29` and
  `test204` (portal).
- The stored value in **your** record is only the locator:
  `{"section_tipo": "zenon1", "section_id": "001338683"}`. Everything else is
  fetched. The `section_id` here is the **remote** id and keeps its exact string
  form (the zero padding is part of it); a local matrix record address is always
  an integer. The rule is the value, not the tipo: a plainly numeric string is a
  record address on any tipo, so only a non-convertible value on an external
  tipo counts as a remote id.

## When the service is down

An external field never goes silently blank. If it cannot show the remote
values it shows a small marker saying why, and a tooltip with the service name,
when the shown data was fetched, and how many values were withheld.

A field that is working shows **no marker at all** — the marker means something
is wrong, so it must never appear on the healthy path:

| Marker | What it means | Worth retrying |
| --- | --- | --- |
| stale | A refresh of these values FAILED, so the last known good copy is shown | yes |
| unavailable | The service answered badly or not at all, and there is no cached copy. Also shown when the service rejects or cannot find EVERY record it is asked for (a wrong address or a changed identifier format): past twenty such answers in a row, a "not found" is no longer believed, and the operator log names the address to check | yes |
| timeout | The service took too long | yes |
| not found | The service answered, and the record is not in it (deleted upstream, or a wrong identifier the service rejected) | no |
| circuit open | The service stopped answering (timeouts, server errors) repeatedly and is being left alone for a cooldown. A rejected or missing record never causes this | yes |
| disabled | An operator has turned this service, or all of them, off | no |
| misconfigured | The connection, the mapping or the allowlist is wrong | no — fix the configuration |

!!! warning "Empty with no marker means empty"
    A field showing nothing **and** no marker really has no value in the remote
    record. A field showing a marker could not be derived. Do not catalogue
    around the second case as if the remote record were blank.

!!! note "The marker is compact in dense views"
    In the `text`, `line` and `mini` views several external fields of one
    record are concatenated onto a single line, so there the marker is a small
    glyph and the full sentence moves into its tooltip. It is shortened, never
    hidden — the state colours are the same, and hovering says the same thing.

The engine also keeps itself polite by construction: values are cached with a
soft age and shared between the fields of one record, requests to one service
are capped in parallel, and a repeatedly failing service is dropped for a
cooldown instead of being re-dialled on every page view.

## Adding a service that is not Zenon

Everything above is cataloguing. A **new** service additionally needs an
adapter — a small server-side description of its request shape, its identifier
form, its payload layout and its named transforms — registered under the name
you will write in `api_config.entity`. Adding one is one file plus one
registration line, with no change to the engine; the checklist lives beside the
adapters in the source tree (`src/external/services/README.md`).

Two things an adapter must state, because they are policy and not detail:

- **What leaves the institution** — identifiers only, search terms, or record
  content. Note that identifiers alone are already a disclosure: they tell the
  remote service which records you hold and how often you consult them. An
  adapter that can search states this twice, once for each path: fetching a
  record sends identifiers, searching sends what a cataloguer typed.
- **What the service can do** — whether it can order, page, back a list column
  or search. Where a capability is missing the engine refuses loudly instead of
  quietly returning something that looks right.

## Searching a service

A search asks the third party which of its records match some words, and the
**server** makes that request — not your browser. That is what puts a search
behind the same controls as every other outbound call: the host allowlist, the
timeouts, the size limit, the circuit breaker and the switch that turns the
whole subsystem off.

What you configure: the target section's `api_config` needs an
`api_url_search`, and the service's adapter must support searching. Missing
either, the engine refuses and says which of the two is missing — it never
answers "no matches", because you would believe it.

Which section gets searched is worked out from the widget's own configuration:
the engine looks at the display fields the widget shows, and the section THOSE
belong to — `zenon1` for the Zenon binding — is the one it searches. The
browser never names it. If one widget somehow shows the fields of two different
external sections, the search refuses and names both rather than guessing: two
sections mean two services, and searching the wrong catalogue would look like a
real answer.

What the engine does with your words:

- an **empty** search box returns nothing, immediately, without contacting the
  service at all;
- the **language** sent to the service is your current data language, so a
  service that labels its answers translates them for you;
- **how many results** to return, and which page, come from the widget asking —
  a request for an oversized page is refused rather than quietly shortened,
  because a shortened page looks exactly like the end of the results;
- the **values** you see obey the same `fields_map`, formats and length limits
  as a record you have already catalogued, so a search result and a saved
  record read identically.

What you see when a search cannot run: the result list says which situation you
are in, instead of looking empty. "External source unavailable" means the
catalogue did not answer and trying again may work; "External source
misconfigured" means this installation has not allowed the service's address
(or the binding is wrong) and no amount of retrying will help — ask whoever
administers the installation; "External source disabled" means it was switched
off on purpose. Typing nothing simply says so, in neutral text: nothing was
searched, so nothing was found.

!!! note "Only an external-backed widget says 'external'"
    Those messages appear when the widget really is bound to a service. An
    ordinary autocomplete that searches Dédalo's own records reports its
    failures in its own terms — it never blames an external source that was
    never contacted, which would send you inspecting a catalogue that had
    nothing to do with it.

!!! info "Why the browser cannot do this itself"
    Dédalo serves a Content-Security-Policy that allows the page to open
    connections only back to Dédalo itself. A browser-side call to a third
    party is blocked before it leaves, and the browser reports that as a bare
    network error with no detail. This is deliberate: the address of a service
    is cataloguing data, and letting the page dial whatever an editable field
    names would hand that reach to anyone who can edit the ontology. Routing
    search through the server is what keeps the address under the operator's
    allowlist. If a service ever appears unreachable **only** from the
    interface, it is this rule doing its job, and the answer is a server-side
    call — never an exception to the policy.

The `search` face of [component_external](../components/component_external.md)
still refuses: that is Dédalo's *own* search index, which cannot hold values it
does not store. Searching an external service goes to the service.
