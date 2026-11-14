---
title: Time machine restore no longer fails on installs whose outbound host allowlist is empty.
type: fixed
audience: admin
date: 2026-09-27
wc: WC-2026-09-27-external-allowlist-at-door-only
---
Before, restoring any value from the [time machine](./using/tools/using_time_machine.md) was
refused when `DEDALO_EXTERNAL_ALLOWED_HOSTS` was empty — which is the default. The error
named a section you had not touched (on a standard install, `test3`) and its external
catalogue host (Zenon), because the engine checked the allowlist while merely reading an
[external service](./core/system/external_services.md) binding, even though a restore
never contacts that service.

Now restores work with no change to your `.env`. The allowlist still guards every request
the server sends out: a request to a host that is not listed is refused before any
connection is opened. Where a host is not allowed, what you see changes in three places: an
external search notice now names the real service and says the host is blocked, and an
external value in a record and an export's degradation report name the real service, all
instead of reporting an unknown, misconfigured source.
