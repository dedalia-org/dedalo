---
title: Third-party packages updated to their latest stable releases, closing every known advisory against them.
type: security
audience: admin
date: 2026-10-24
---
The engine and the publication packages (the v2 publication API, the site builder and
the publication-host agent) now install with no known security advisory, measured
against the public advisory feed at release time. Twenty-one advisories are closed:
`body-parser`, `qs`, `undici`, `fast-uri`, `serialize-javascript`, `hono`,
`ip-address`, `vite` and `zod` move to their fixed releases, and `nodemailer`, which
sends Dédalo's mail, moves to 10.2.1.

Other notable moves in this release:

- **zod 4.6.7**, the validation library, is now the only copy in every package.
- **Anthropic SDK 1.3.0** (was 0.131) for the Dédalo assistant. It speaks the newer
  API version 2026-10-21 and sends the API key in the `Authorization` header
  instead of `X-Api-Key`. Nothing changes for an installation that reaches the
  Anthropic API directly. If outbound traffic goes through a proxy or gateway that
  reads `X-Api-Key`, make it read `Authorization` instead.
- **Swagger UI 5.34.0** (was 5.33.1) and **Scalar API reference 1.76.0** (was 1.72.4)
  on the v2 publication API's documentation pages. The legacy v1 API's Swagger page
  moves from 5.32.14 to the same 5.34.0 (see
  [vendored library versions](./development/vendored_library_versions.md)).
- **OpenTUI 0.6.8** (was 0.6.1), the terminal installer's interface library.
- **Biome 2.6.3** (was 2.5.15), the code checker. Nothing changes for an
  installation; this only affects development checks.
- **actions/upload-artifact 7.0.2**, in the release and CI workflows.

The Bun runtime pin stays at 1.4.3.
