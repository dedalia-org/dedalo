# Tool template (`tool_dev_template`)

> See also: [Tools user guide](index.md) · [Developer reference](../../development/tools/reference/tool_dev_template.md)

The reference implementation a new Dédalo tool is copied from — a working sample that demonstrates the whole tool contract, meant for developers building tools, not for cataloguing work.

!!! info "This is a developer tool"
    `tool_dev_template` is a scaffold and reference, not a feature. It does no real work on your data — it exists so a developer can start a new tool from a known-good example. If you are cataloguing, there is nothing here for you.

## What it's for

Every Dédalo tool follows the same shape: a server module with declared actions and permission gates, a client that runs an `init → build → render` lifecycle, and a `register.json` that describes it. `tool_dev_template` is a small, production-shaped tool that exercises all of that in one place — the four kinds of permission gate, a background-runnable action, the availability and registration lifecycle hooks, and the common client patterns (rendering a field, calling the server, uploading a file). A developer copies it to get a correct starting point instead of assembling one from scratch.

## When to use it

- You are a developer creating a new tool and want a working template to copy and rename.
- You want a concrete, annotated example of how the tool contract fits together.

You do not "use" it as a cataloguer, and it should not be granted or relied on in a production install — it is a sample to copy, not a workflow.

## Where to find it

As a sample it is not meant to surface in a real install. When registered for study it opens in its own window and shows an information panel plus a few demo buttons that illustrate the standard patterns. The real starting points for building a tool are the developer guides linked below, not this window.

## Using it

To create a new tool from the template, a developer runs the CLI scaffolder, which copies the template directory and renames everything:

```shell
bun run scripts/create_tool.ts \
    --name=tool_myorg_mytool \
    --label="My tool"
```

The new tool is created but not yet active — it is registered with the *Register tools* maintenance widget and then granted to the profiles that should see it. The full walkthrough is in [Creating new tools](../../development/tools/creating_tools.md).

## Related

- **[Creating new tools](../../development/tools/creating_tools.md)** — the end-to-end tutorial that starts from this template.
- **[Developer reference](../../development/tools/reference/tool_dev_template.md)** — the annotated tour of the template: the server module, the four permission kinds, the background and lifecycle hooks, and the client patterns.
- **[Error report](using_error_report.md)** — another developer/administrator tool.
