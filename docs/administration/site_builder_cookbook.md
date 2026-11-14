# Site builder cookbook

Practical recipes for configuring and using the [site builder](site_builder.md): concrete
configuration blocks, the day-to-day workflow, and a library of prompts you can copy,
adapt, and hand to the agent.

This page assumes you have read the [overview](site_builder.md). It shows examples; it does
not repeat the concepts.

---

## Recipe 1 — Declare the instance and pair the engine

Installing a site builder is **not** copying configuration files into place. You write one
declaration for the museum and the provisioner generates everything on the host from it: the
Linux user and group, the roots, the systemd unit, the virtual hosts, the daemon's
environment file, the preview password file, the site table and the engine pairing fragment.
The full procedure — every field, the credential rules, the dry run — is in
[Site builder](site_builder.md#adding-a-museum). This recipe is the short version.

**1. Declare it** in `/etc/dedalo_sites/instances/<instance>/instance.json`:

```json
{
  "instance": "museum-d",
  "engine": {
    "private_dir": "/srv/dedalo/museum-d/private",
    "group": "dedalo-museum-d",
    "checkout_dir": "/srv/dedalo/museum-d/master_dedalo",
    "bun_bin": "/srv/dedalo/museum-d/.bun/bin/bun"
  },
  "web": { "server": "nginx", "group": "www-data" },
  "publication_api": { "url": "http://127.0.0.1:3104/publication/server_api/v2" },
  "sites": [ { "slug": "coleccion", "domain": "www.museum-d.example" } ],
  "serving": {
    "preprod": { "enabled": true, "auth": { "mode": "htpasswd", "users": [
      { "name": "preview",
        "password_file": "/etc/dedalo_sites/instances/museum-d/secrets/PREPROD_PASSWORD" } ] } },
    "prod": { "tls": { "mode": "letsencrypt", "account_email": "ops@museum-d.example" } }
  },
  "agent": { "driver": "claude_code", "bins": { "claude_code": "/usr/local/bin/claude" } },
  "secrets": {
    "ANTHROPIC_API_KEY": "/etc/dedalo_sites/instances/museum-d/secrets/ANTHROPIC_API_KEY"
  }
}
```

Note what is *not* in there: no credential values, only the paths of root-owned `0600` files
(a pasted secret is refused by name), and no roots — they are derived unless you state them.

**2. Place the credentials** those paths name, then dry-run and apply:

```bash
cd /opt/dedalo/master_dedalo/publication/site_builder
sudo bun run provision check --instance museum-d    # writes nothing; exit 1 = drift
sudo bun run provision apply --instance museum-d
```

`apply` mints the shared bearer into `secrets/SERVICE_TOKEN` itself. You never type it, and
re-running the provisioner never rewrites it.

**3. Pair the engine** from the rendered fragment, on the engine's host:

```bash
bun run scripts/site_builder_pair.ts \
  /etc/dedalo_sites/instances/museum-d/engine.env.fragment \
  --token-file /etc/dedalo_sites/instances/museum-d/secrets/SERVICE_TOKEN
```

That appends `DEDALO_SITE_BUILDER_INSTANCE`, `DEDALO_SITE_BUILDER_SOCKET` and
`DEDALO_SITE_BUILDER_TOKEN` to `../private/.env` — documented keys only, refusing rather than
overwriting a key that is already there with a different value, and printing no secret. Every
key is in the [settings reference](configuration/config.md#sitebuilder). Restart the engine, then
register the tool with the *Register tools* maintenance widget.

### Using a local model instead of Claude

The daemon is driver-agnostic. To drive the agent with an OpenAI-compatible endpoint (for
example a local model) through the OpenCode driver, change the declaration's `agent` block
and the credential it names, then `apply`:

```json
"agent": { "driver": "opencode", "bins": { "opencode": "/usr/local/bin/opencode" } },
"secrets": { "OPENCODE_ENV": "/etc/dedalo_sites/instances/museum-d/secrets/OPENCODE_ENV" }
```

`OPENCODE_ENV` is a credential file, not a declared value: its contents are the variables
forwarded to the OpenCode child, for example
`OPENAI_API_KEY=…,OPENAI_BASE_URL=http://127.0.0.1:11434/v1`. Agent binaries are absolute
paths, never bare command names — on a host running several museums a bare name is resolved
through the shared search path, which is another instance's chance to choose which binary
runs as this museum's user.

Nothing else changes — the workspace, build, and publish flow are identical.

---

## Recipe 2 — Decide who can build and who can publish

- **Build a site** — any user granted the `tool_sitebuilder` tool through their profile.
  Grant it the same way you grant any tool. Administrators have it automatically.
- **Publish to production** — developers and global administrators only. This is enforced by
  the engine, not by trust: a non-developer never gets a Publish button, and a hand-crafted
  request is refused.

The launcher lives in **Area maintenance → Publication → Site builder** (it opens the
workspace in its own window). Because Area maintenance is admin/developer-gated, that is who
reaches the launcher.

---

## Recipe 3 — Build your first site

1. Open **Area maintenance**, find the **Site builder** panel (Publication subsystem), and
   click **Open site builder**.
2. In the left pane, type a slug (lowercase letters, digits, hyphens — e.g. `photo-archive`)
   and a name, then create the site. The daemon scaffolds a starter project and points its
   data helpers at your publication API.
3. In the chat, describe what you want. Work in stages rather than one big prompt (Recipe 4).
4. When the agent stops, click **Build**. On success the preview reloads.
5. Review the preview. When it is right, **Publish** (if you may).

A good first prompt sets the goal and lets the agent discover the data:

> Build a landing page for this archive. First call the MCP tools to list the databases and
> the tables, pick the main records table, and show its 20 most recent records as cards with
> a title and a thumbnail. Keep it clean and responsive. Use the helpers in
> `src/lib/dedalo.ts` for every request.

---

## Recipe 4 — Work in stages: plan, mockup, then refine

The agent does its best work when you build up in stages instead of asking for the finished
site in one prompt. Each stage is a cheap checkpoint before the next — and every turn is
committed, so you always have a working point to fall back to.

**Stage 1 — Ask for a plan first, before any code.** This catches a wrong direction while it
still costs nothing to change.

> Before writing any code, look at the data — list the databases and tables, and read the
> schema of the main ones — and propose a plan for a public site: the pages, what each one
> shows, which tables and columns it uses, and the libraries you would choose. Don't build
> anything yet; just the plan.

Read it, correct it, then approve:

> Good, but drop the login page — everything here is public — and use a timeline instead of a
> table on the home page. Go ahead with that plan.

**Stage 2 — Ask for a rough mockup, layout first.** A quick static draft lets you judge the
look and structure before the agent spends effort on data plumbing.

> Build a static mockup of the home page from the plan: the real layout, header and
> navigation, but with a few hard-coded sample records instead of live API calls. One page
> only, so I can see the shape.

Build it, preview it, and adjust the shape cheaply:

> Move the search box into the header, make the cards two per row, and add a footer.

**Stage 3 — Wire the real data and fill in the rest.** Once the shape is right, turn the
mockup into the real thing.

> Now replace the sample records with live data from the `[documents]` table using the helpers
> in `src/lib/dedalo.ts`, add the other pages from the plan, and handle empty results and
> errors.

This beats one big prompt because each stage is small enough to review, a wrong turn is caught
early and cheaply, and you are never far from a working version. Use **Stop** the moment a turn
heads the wrong way, then correct course in the next message.

---

## Recipe 5 — Prompt library by visualization

The generated sites read the published data through the Publication API, and the agent has
the API's MCP tools wired in (`list_databases`, `get_schema`, `search_records`, `get_record`,
`count_records`, `fulltext_search`, and the fragment tools). Records are keyed by
`section_id`, and multilingual tables return one row per language — mention the language you
want when it matters.

Copy a prompt, replace the bracketed parts with your table and column names (ask the agent to
`get_schema` first if you do not know them), and send it.

### A map

> Add a page with a full-screen Leaflet map. Pull records from the `[places]` table, read the
> latitude and longitude from `[gis_lat]` / `[gis_lon]`, and drop a marker for each. Show the
> record title in the popup, and fit the map to the markers. Skip records with no coordinates.

### A bar or line chart

> Add a chart page using Chart.js. Group the records in `[objects]` by `[material]` and show a
> horizontal bar chart of the count per material, top 15, sorted descending. Fetch up to 500
> records and aggregate client-side.

### A timeline

> Build a timeline of the `[events]` table ordered by `[date_start]`. Render each event as a
> row with its year, title and a one-line description, grouped by decade. Make the decades
> collapsible.

### A searchable index

> Add a search box that calls the publication API full-text search on the `[documents]` table
> and renders the results as a list, with the query debounced by 300 ms and a result count.
> Link each result to a detail page for that record.

### A record detail page

> Add a detail route `#/record/:id` that loads a single record from `[documents]` by its
> `section_id`, shows every non-empty field as a labelled row, and renders any related images
> from the `[image]` relation. Fall back to a "not found" message for an unknown id.

### A gallery

> Make an image gallery from the `[image]` table: a responsive grid of thumbnails that open a
> larger view on click. Lazy-load images and show the caption under each one.

### Filters and facets

> Above the results list, add facet filters for `[period]` and `[country]`. Populate each
> facet's options from the distinct values in the first 500 records, and combine active
> filters with AND. Reflect the active filters in the URL hash so a filtered view is
> shareable.

---

## Recipe 6 — Iterate with follow-up prompts

The agent keeps the session context, so follow-ups are short and refer to what is on screen:

> Make the cards bigger and show two per row on desktop, one on mobile.

> The dates render as raw numbers — format them as years, and sort newest first.

> Add a header with the archive name and a link back to the home page on every page.

> Some records have no image; show a neutral placeholder instead of a broken image.

> Switch the whole site to a dark theme with good contrast.

If a turn goes wrong, click **Stop**, then correct course:

> Stop. That removed the navigation. Put the nav back exactly as it was and only change the
> colours.

Every turn is committed, so the site's history is a safety net even though the UI does not
yet expose a visual rollback of agent turns.

---

## Recipe 7 — Build, preview, and publish

- **Build** runs the site's install and build commands and promotes the static output to the
  pre-production address. The preview iframe reloads with a cache-busting parameter, so you
  always see the fresh build.
- **Preview** is served behind HTTP basic auth by default, on the site's own domain with the
  preview prefix (`pre.www.museum-d.example`). The reviewer name is declared in
  `serving.preprod.auth.users[]` and its password is the root-owned file that entry names;
  share that credential with anyone reviewing a draft.
- **Publish** copies the exact bytes you previewed to the production address — it does not
  rebuild, so what goes live is what you approved. You are asked to confirm, and the action
  names the public URL.

A typical review-to-launch sequence:

1. Build → check the preview.
2. A couple of follow-up prompts → Build again → re-check.
3. Publish → confirm → the site is live on its own domain (`www.museum-d.example`).

---

## Recipe 8 — Roll back a production site

Every publish keeps the previous releases. If a launch has a problem, roll back to the last
good release from the workspace's release history — production swaps back atomically, with no
rebuild. Because production is an independent copy of each release, a rollback never depends
on the workspace still existing.

---

## Recipe 9 — Multiple sites and a custom domain

Every site has its own domain, and that domain is a **declared field** — there is no virtual
host to write and no document root to point anywhere.

```json
"sites": [
  { "slug": "coleccion", "domain": "www.museum-d.example" },
  { "slug": "archivo",   "domain": "archive.museum-d.example" }
],
"serving": { "aliases": { "museum-d.example": "coleccion" } }
```

- Each entry in `sites[]` gets a production vhost and a pre-production vhost, generated.
- `serving.aliases` maps an *extra* hostname onto a declared slug — the target must be a
  slug you declared, and it must not already be another site's canonical domain.
- `sites[].webspace` overrides where the site's directory lives, for a museum whose site is
  already served from somewhere the host's convention does not cover.

Then `sudo bun run provision apply --instance <instance>` and add the DNS record. TLS follows
`serving.prod.tls.mode` — `letsencrypt`, `files` or `none` — and has no default. You can run
as many sites as the declaration's `limits.max_sites` allows.

---

## Recipe 10 — Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| The **Site builder** panel shows "Not configured" | The engine's pairing keys are unset, or only some of them are — a transport with no instance or no token resolves to no transport at all | Append the pairing fragment with `scripts/site_builder_pair.ts`, restart the engine, register the tool. |
| The panel shows "Configured, but not reachable" | The daemon is down, or the socket is not readable by the engine's group | `systemctl status dedalo-site-builder@<instance>`, then `sudo bun run provision check --instance <instance>` — a wrong `engine.group` in the declaration is exactly this symptom. |
| Everything answers, but every call is refused as an instance mismatch | This engine's `.env` names a different instance or a different token than the daemon it is talking to | The two must be one pairing. Re-read the daemon's fragment; a `.env` copied from another museum's server is the case this refusal exists to catch. |
| The host stops matching what you think you configured | Somebody edited a generated file | `sudo bun run provision check --instance <instance>` names every drifted artifact; `apply` restores them. Change the declaration, never the generated file. |
| The launcher is missing entirely | You are not an admin/developer, or the tool is not granted | The launcher lives in Area maintenance (admin/developer). For build access, grant `tool_sitebuilder` in the user's profile. |
| A build fails | The agent's code does not build | Read the build log in the chat; ask the agent to fix the specific error it reports. |
| The preview is blank | The site fetched no data, or a runtime error | Ask the agent to handle empty results and check the browser console; confirm the table and column names with `get_schema`. |
| "No agents available" | No coding-agent binary is installed at the absolute path the declaration names | Install the CLI, correct `agent.bins` in `instance.json`, place the provider key in the `secrets/` file the declaration names, and `apply`. |

---

## See also

- [Site builder](site_builder.md) — the overview and enabling steps.
- [Settings reference — Site builder](configuration/config.md#sitebuilder) — every configuration
  key.
