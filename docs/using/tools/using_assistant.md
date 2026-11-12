# AI assistant (`tool_assistant`)

> See also: [Tools user guide](index.md) · [The AI Assistant](../../administration/ai/assistant/index.md)

A chat panel inside the work application that lets you talk to your catalogue in natural language — search, read, explain, and (when you allow it) propose edits — through the same permissions you already have.

## What it's for

The assistant lets you ask your catalogue questions the way you would ask a colleague: *"find every interview about the reservoir"*, *"what is in this record?"*, *"create a person named Anna Pujol and link her to this testimony"*. It searches by meaning as well as by exact words, reads and explains records in your language, and — with write mode enabled — drafts changes for you to review and confirm before anything is saved. It never sees more than you could see through the normal client, and it never writes on its own.

## When to use it

- You want to find records by meaning, not just by an exact string match.
- You want a record read back or explained, with links so you can open the sources.
- You want help drafting an edit that you will review and confirm.

It works on your private work data inside the editing application. It is not the public Publication API, and it is not an autonomous editor — in write mode it proposes a change plan that you approve op by op.

## Where to find it

The assistant opens as a chat panel from the work application (it opens as a modal). It is available where your installation has enabled and configured it, **and your profile grants the assistant tool** — the assistant, its model and its privacy controls all live on the Dédalo server, so whether it appears, and which models you can pick, depends on how an administrator set it up. If the assistant answers that you are not authorized, ask an administrator to grant the assistant tool to your profile.

## Using it

The full user and operator documentation lives in its own section — this page is only the tool's entry in the catalog.

- To use the assistant day to day (asking questions, attaching an image, reviewing and applying proposed changes, picking a model per conversation), start at **[The AI Assistant](../../administration/ai/assistant/index.md)**.
- For what it can and cannot do, and how it stays inside your permissions, see the same section's overview.

!!! info "Full documentation elsewhere"
    Everything about configuring, connecting a model, securing and using the assistant is documented under [The AI Assistant](../../administration/ai/assistant/index.md). This page intentionally does not duplicate it.

## Related

- **[The AI Assistant](../../administration/ai/assistant/index.md)** — the complete guide: what it does, how to use it, installing, connecting models, privacy and security.
- **[User panel](using_user_admin.md)** · **[Site builder](using_sitebuilder.md)** — other tools launched from the application chrome rather than from a record.
