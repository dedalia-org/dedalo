# System / infrastructure

> The shared, mostly non-ontological machinery that the rest of Dédalo runs on:
> the bootstrap loader and base class, the database access layer, authentication
> and authorization, media processing and protection, the search engine and HTTP
> API, versioning, the operational services (backup, logging, runtime helpers)
> and the publication pipeline.

> See also: [Architecture overview](../architecture_overview.md) · [RQO](../rqo.md) (request format) · [SQO](../sqo.md) (search query) · [dd_object (ddo)](../dd_object.md)

These pages are the subsystem references for the infrastructure layers under
`src/core/`. Unlike sections and components, most of what is documented here is
**not** ontology-driven — these are stateless engines, the bootstrap and the
runtime plumbing. For the request/response contract that ties the work system
together, start with [RQO](../rqo.md); for the conceptual split between the work
system and the publication system, read the
[Architecture overview](../architecture_overview.md).

## Subsystems by concern

| Subsystem | Concern | Purpose |
| --- | --- | --- |
| [The engine layer](common.md) | Base &amp; data | The horizontal engines that resolve any element — identity, structure context, `request_config`, permissions and language — from its ontology node and its per-model descriptor. No base class, no inheritance. |
| [Bootstrap](base.md) | Base &amp; data | How the server starts: the frozen config catalog, the static module graph, the component registry and the `Bun.serve` process entry. |
| [db](db.md) | Base &amp; data | PostgreSQL access layer over Bun's SQL client — the only work-system code that issues SQL, with the matrix read/write functions and the single JSONB byte-compat codec. |
| [dd_grid](dd_grid.md) | Base &amp; data | Resolves a record's component data into flat, tabular shapes: the legacy grid cell and the modern per-component export-atoms contract, plus the client renderers. |
| [login](login.md) | Auth &amp; security | Authentication entry point — validates credentials against the users section, builds the session and arms the media-protection auth cookie. |
| [security](security.md) | Auth &amp; security | Authorization core — turns a user profile into an integer permission (0–3) over any ontology element and enforces it server-side on every read, write and per-record access. |
| [media_protection](media_protection.md) | Auth &amp; security | Web-server-enforced media access control — generates the `.htaccess` gate, the fixed-name auth cookie and the zero-byte marker allowlist that authorize media with a single `stat()`. |
| [media_engine](media_engine.md) | Media | Media processing layer — stateless `Ffmpeg`/`ImageMagick` wrappers that shell out to transcode, resize, rasterize, probe and derive files for the media components. |
| [search](search.md) | Search &amp; API | Query engine — compiles a Search Query Object ([SQO](../sqo.md)) into a single prepared PostgreSQL statement over the JSONB `matrix_*` tables and returns an iterable result. |
| [api](api.md) | Search &amp; API | Single HTTP entry point of the work system — decodes a Request Query Object ([RQO](../rqo.md)), runs the security gates, dispatches to a `dd_*_api` handler and returns the standard JSON envelope. |
| [map_tile_proxy](map_tile_proxy.md) | Search &amp; API | The same-origin, authenticated relay of map tiles — a request names a stored source, an ontology default or a built-in id and never an address; the server checks the permission, builds the provider's address, fetches through the harvesting door's interactive profile and relays only verified images. |
| [geo_services](geo_services.md) | Search &amp; API | The closed table of public geographic lookups a tool can ask for — Nominatim, DARE, Catastro, IGN, open-elevation — each with its own grammar, byte ceiling, deadline and pacing; the request names a service id and never an address. |
| [errors](errors.md) | Search &amp; API | The closed failure vocabulary — one registered code per refusal, the single converter that builds every wire body, envelope v2 with its notices and extension keys, the disclosure ladder and the client error policy. |
| [Server-side observers](observers.md) | Write cascade | Save-time propagation — components that declared an interest in a saved component recompute after the save commits: external mirrors (`set_dato_external`), info/state widget recomputes and relay chains, discovered from `properties.observe` alone. |
| [tm_record](tm_record.md) | Versioning | Time Machine (`dd15`) runtime object — one historical version of a component/section change in the flat `matrix_time_machine` table, with read-only `tm` mode and restore. |
| [backup](backup.md) | Ops | Dumps and lists the PostgreSQL work database via a version-matched `pg_dump`, driven by the `make_backup` maintenance widget. |
| [Activity log](logger.md) | Ops | The user-activity audit trail: one structured row per state-changing action, appended to `matrix_activity`. |
| [External record services](external_services.md) | Search &amp; API | Server-side resolution of records held by a third party (a bibliographic catalogue, an authority file): the section's `api_config` binding, the per-field mapping, the outbound controls (host allowlist, timeout, circuit breaker, row cache) and the degradation states that keep an unreachable source from looking like an empty record. |
| [services](services.md) | Ops | Reusable client-side helpers — file upload, rich-text editing, autocomplete search, … — whose server side is the generic API dispatch actions. |
| [diffusion](diffusion.md) | Publication | Publication subsystem — emits the work data marked for publication to external targets (MariaDB SQL tables and RDF/XML/Markdown/CSV/JSON files), driven by the diffusion ontology and run natively by [the diffusion engine](../../diffusion/native_engine.md). |
