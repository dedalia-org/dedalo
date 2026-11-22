---
title: Object identification's grouping run refuses a language the installation does not have.
type: fixed
audience: developer
date: 2026-11-22
---
The `cluster` action of the identification tool accepted any `lang` the caller sent
and compared records in it, so a misspelled code or a language the installation does
not catalogue in silently compared empty values. The `lang` option is now checked
before anything runs: it must be a language code and one of the installation's data
languages, or the request is refused with `request.invalid_options`. Leaving it out
still uses the request's data language. A background run is refused when it is
submitted, so a refused language no longer leaves a failed job behind. See the
[tool_identify reference](./development/tools/reference/tool_identify.md).
