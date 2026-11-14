# Error report (`tool_error_report`)

> See also: [Tools user guide](index.md) · [Error reports](../../administration/error_reports.md) · [Developer reference](../../development/tools/reference/tool_error_report.md)

Report a problem to the Dédalo maintainers the moment it happens: the tool collects the current page context and any JavaScript errors captured since the page loaded, you add a description, and it sends the report to a central master installation.

## What it's for

When something goes wrong in the interface, the most useful bug report is the one filed from the exact page where it broke, with the technical error already attached. This tool does that: from any page it gathers the page context and the browser's captured JavaScript errors, lets you describe what you were doing, and relays the whole thing to the maintainers — so you do not have to reproduce the fault or copy error text by hand.

!!! info "This is an administrator tool"
    The report button and form are shown to global administrators only. If you are not an administrator you will not see the launcher, and the server refuses reports from anyone else.

## When to use it

- You hit an error, a broken view, or unexpected behaviour and want to report it with the technical context attached.
- You are an administrator triaging a problem a user showed you, on the page where it happens.

For the operator-facing side of the feature — enabling it, configuring where reports go, and browsing reports received on a master installation — see [Error reports](../../administration/error_reports.md).

## Where to find it

A small circular launcher sits at the **bottom-right of every page** (shown to global administrators only). It works from anywhere — a record edit, a list, the thesaurus tree, an area dashboard, even a menu-less pop-up window. Clicking it opens the report dialog.

## Using it, step by step

1. When you hit the problem, click the **report launcher** at the bottom-right of the page. The dialog opens.
2. Review the **context summary** it shows: the current section / page, your user, and the count of JavaScript errors captured since the page loaded.
3. Expand **Captured JavaScript errors** to see the technical details that will be attached.
4. Write a **description** of what you were doing and what went wrong (required).
5. Press **Send report**. Nothing leaves your browser until this click — the captured errors accumulate locally and are only sent when you send.
6. Wait for the confirmation line. Your own server stamps the trusted identity and relays the report to the configured master installation.

## Options

The report is assembled for you; there is nothing to configure. What it sends:

| Included | Note |
| --- | --- |
| Your description | The free text you write (required). |
| Page / section context | The page path (navigation parameters only) and the section locator. |
| Captured JavaScript errors | The most recent errors buffered since the page loaded, expandable before you send. |
| Identity and version | Stamped by the server, not the browser — your user id, the installation and engine version, languages and timestamp. |

## Tips and gotchas

!!! tip
    Report from the page where the fault occurred, before navigating away — the captured JavaScript errors are what make the report actionable, and they reset when the page reloads.

!!! warning
    Free-text descriptions and captured error messages **may contain record data** (which can be personal or sensitive). The report crosses to the master installation's operator, and the explicit *Send report* click is the consent moment — describe the problem, but avoid pasting sensitive record content into the description.

!!! note
    The report always goes to the master installation configured by your operator. If reporting is not configured on your server, the tool tells you so honestly rather than sending nowhere.

## Related

- **[Error reports](../../administration/error_reports.md)** — the operator guide: enabling reporting, the receiver side, and the dashboard widget that browses received reports.
- **[User panel](using_user_admin.md)** · **[AI assistant](using_assistant.md)** — other tools launched from the application chrome rather than a record.
- **[Developer reference](../../development/tools/reference/tool_error_report.md)** — the send action, what is collected, identity stamping and security.
