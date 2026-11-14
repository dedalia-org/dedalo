# Site builder (`tool_sitebuilder`)

> See also: [Tools user guide](index.md) · [Site builder](../../administration/site_builder.md) · [Site builder cookbook](../../administration/site_builder_cookbook.md)

Build a public website over your published data by talking to a coding agent, preview it, and — once it looks right — publish it to production.

## What it's for

The site builder lets you create a public website — maps, charts, interactive analysis, a landing page — on top of the data your installation already publishes, without hand-writing code. You describe what you want to a coding agent in a chat, watch a live preview take shape, and publish it live when you are happy. The generated site reads only from the read-only publication data, so it can never reach your private work-system records.

Concrete scenario: an oral-history archive wants a public page with a map of every interview location and a timeline. A user opens the site builder, creates a site, asks the agent to build the map and timeline, refines it over a few messages while watching the preview, and then a developer or administrator publishes it to the public address.

!!! info "Optional add-on"
    The site builder only appears when an administrator has provisioned its daemon for this museum and paired this engine with it. Until then it is completely hidden — the tool is not in your toolbar and its actions refuse.

## When to use it

- You want a public website built over your published data and are happy to guide it by conversation.
- You want to preview a site on a pre-production address before anything goes live.

The people who *build and preview* sites need the tool granted to them; the final step of *publishing to production* is restricted to developers and administrators.

## Where to find it

The launcher appears in **Area maintenance**, under the **Publication** subsystem, as the **Site builder** panel — open it there. It opens in its own window as a workspace with a site list, a chat with the agent, a live preview, and (for those permitted) a publish action. Administrators have the tool automatically; other users need it granted through their profile.

## Using it

The day-to-day workflow and a library of example prompts live in the management guides — this page is only a short orientation.

- For the workflow (create a site, chat with the agent, preview, publish) and a catalogue of prompts to try, see the **[Site builder cookbook](../../administration/site_builder_cookbook.md)**.
- For how the pieces fit together — and, for an administrator, how a museum's instance is declared, provisioned, adopted, decommissioned and backed up — see **[Site builder](../../administration/site_builder.md)**.

## Tips and gotchas

!!! tip
    Preview first. What you publish is the exact set of files you previewed on the pre-production address — the site's own domain with a `pre.` prefix, behind a password your administrator gives you — so get the preview right before taking it live.

!!! warning
    Publishing takes a site to its public address and needs a developer or administrator; it also requires an explicit confirmation. Removing a site can optionally purge the published copy — only do that when you truly want the live site torn down.

## Related

- **[Site builder](../../administration/site_builder.md)** — the administrator's guide: declaring an instance, provisioning it, drift, adoption, decommissioning, backups.
- **[Site builder cookbook](../../administration/site_builder_cookbook.md)** — the workflow and example prompts.
- **[AI assistant](using_assistant.md)** — the in-app assistant for searching and editing your *work* data (a different surface from the public site builder).
- **[Developer reference](../../development/tools/reference/tool_sitebuilder.md)** — the tool's actions, permission gates, and how it proxies the daemon.
