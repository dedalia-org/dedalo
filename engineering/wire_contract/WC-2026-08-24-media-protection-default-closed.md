# WC-2026-08-24-media-protection-default-closed — media access control defaults to ON

- **Date:** 2026-08-24.
- **Decision:** an install that configures no media access mode now resolves to
  `'publication'` instead of `false`. Anonymous visitors to such an install stop
  being able to read arbitrary media (200 → 404 for anything not published in a
  public quality folder), and `page_globals.dedalo_protect_media_files` becomes
  `1` where it was `0`.

## Why

`resolveModeSource()` described the old state in its own words: *"default — no
media protection configured (media is world-readable)"*. An institution that
installed Dédalo and configured nothing served its ENTIRE media tree — every
unpublished record, every master-quality original, every rights-restricted
image — to anyone who could guess a URL. The behaviour was documented; being
documented is not being defended, and for a heritage system the default has to
be the safe one. "The operator will configure it" is not a mechanism.

## Why `'publication'` and not `'private'`

On an install with no publications the two are behaviourally identical: the
`pub/` marker directory is empty, so every anonymous request fails rule B and
404s. They diverge only later — and there, `'private'` would silently 404 the
archive's OWN published site the day diffusion writes its first marker. A
default that becomes wrong once the system is used as intended is a trap.
`'publication'` is closed now and still correct then.

## Shape before → after

| situation | before | after |
|---|---|---|
| no key set | `false` (world-readable) | `'publication'` |
| `DEDALO_MEDIA_ACCESS_MODE=''` | `false` | `'publication'` |
| a TYPO (`privat`, `public`) | `false` — **a misspelling published the archive** | `'publication'`, still logged loudly |
| `DEDALO_MEDIA_ACCESS_MODE=false\|off\|0` | `false` | `false` — **explicit opt-out, honoured** |
| `DEDALO_PROTECT_MEDIA_FILES=false` | `false` | `false` — honoured |
| `DEDALO_PROTECT_MEDIA_FILES=true` | `'private'` | `'private'` |
| an explicit mode | that mode | that mode |

An explicit `false` remains a real choice: an operator who deliberately serves
an open media tree said so. What is refused is SILENCE.

## The three ways this could have shipped as an outage instead of a fix

A fail-closed default is easy; one that does not brick the installs it protects
is the requirement. Each of these is enforced by a gate:

1. **The web-server-less install.** `mediaFallbackAllowed()` stood the engine's
   own media route down whenever a mode was set. Under a flipped default that
   would 404 every image, video and PDF for LOGGED-IN EDITORS on the documented
   `dev_quickstart` flow — with `MEDIA_DEV_ROUTE_ENABLED` unable to help, since
   it is inert once a mode is set. The route now keys on the mode's SOURCE: it
   stands down where an operator CHOSE, and keeps serving the dev listener where
   nobody did. (`test/unit/media_fallback_listener.test.ts`)
2. **Login.** `initMediaAuthCookie()` throws when a mode is set and `MEDIA_PATH`
   is not — and it runs inside login, before `createSession`. Under a flipped
   default nobody could log in to an install whose media root is not set up yet:
   a security default that locks the operator out of the fix. It still throws
   for an EXPLICIT mode (that is a misconfiguration, and the existing gate is
   unchanged); for the default source it logs and returns null.
3. **nginx.** Apache reads `.htaccess` per request, nginx reads its include at
   reload. An unreloaded nginx keeps serving everything with a green widget, so
   boot now emits one warning naming the mode, the includes and
   `nginx -t && nginx -s reload`.

## Wire-visible surface

- Anonymous media GETs on previously-unconfigured installs: **200 → 404** unless
  the record is published and the file is in a public quality folder.
- `page_globals.dedalo_protect_media_files`: **0 → 1** on those installs
  (`src/core/resolve/environment.ts`). The frozen parity fixture already holds
  `1`, so no fixture edit — the fixture was harvested against an install that
  had configured the mode.
- The maintenance widget gains `mode_decided_by` (`state|env|legacy|default`),
  and `mode_source` no longer contains the string "world-readable".
- `/health` deliberately gains NOTHING: it is unauthenticated, and advertising
  "this install's media is world-readable" there is a disclosure that helps only
  an attacker. The authenticated widget and the boot log carry it instead.

## Operator note

An install whose public website consumes media OUTSIDE the derived public
quality folders, or serves media from a DIFFERENT host than the app (so the
auth cookie is never attached), will see anonymous 404s. Both are visible
immediately and both have explicit answers: configure
`DEDALO_MEDIA_PUBLIC_QUALITIES`, fix the cookie domain, or set
`DEDALO_MEDIA_ACCESS_MODE=false` deliberately.

## Gate

`test/unit/media_protection_default_native.test.ts` (the resolution table above,
mutation-verified: restoring the `false` default turns it red) plus two new rows
in `test/unit/media_fallback_listener.test.ts` (the source distinction, both
directions). Catalog default and its doc regenerate `install/sample.env` and
`docs/administration/configuration/config.md` — `config_docs_tripwire` requires byte identity.
