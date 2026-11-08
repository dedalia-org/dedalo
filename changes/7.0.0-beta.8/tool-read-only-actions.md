---
title: A tool action that only reads can declare itself read-only, so a failed lookup shows its real error.
type: added
audience: developer
date: 2026-11-06
---
A tool action that only reads, such as a place-name search against an outside service, can now declare itself read-only. The server does not remember a read-only action in its duplicate-request protection, so when it fails (the outside service answers with an error) a resend of the same request shows the real error again, instead of the message that the outcome of the first attempt is unknown. That message is meant for actions that write: it stops a resend from creating a second record. A read-only action cannot create one, and the server refuses it a write to a record, an item-id counter, a record's history or a background job; its activity-log entries are dropped and noted in the server log, and writes to media files or to other stores are the tool developer's responsibility, which nothing checks. Because nothing remembers a read-only action, the browser's own automatic retry of a stalled call would repeat the call to the outside service, so the tool's browser code calls it once (`retries: 1`). A test reads the browser code of every tool that declares a read-only action and checks this, and it refuses such a tool building the request by hand instead of through `tool_request`.

No shipped tool declares it yet except the developer template, which shows how; the existing tools keep their current behaviour until they do. Tool developers declare it next to the action's permission, see the [tools server contract](./development/tools/server_contract.md#read-only-actions-readonly-true).
