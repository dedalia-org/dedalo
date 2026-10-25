---
title: Dédalo prereleases are now published releases — from 7.0.0-beta.7 on, each beta is a fixed, signed version you can install and update.
type: changed
audience: admin
date: 2026-10-19
breaking: true
wc: WC-2026-10-15-release-identity-from-tag, WC-2026-09-29-code-release-channel-refs
---
Until 7.0.0-beta.6, a beta was never published: its code reached an installation only
as a developer build, and its Docker image only by building it yourself. From
7.0.0-beta.7 on, every prerelease (`-alpha.N`, `-beta.N`, `-rc.N`) is published the way
a release is, under its own name: a code archive with a checksum on the code server, and
a signed official image `:7.0.0-beta.7`. Neither is ever rebuilt, so a bug report that
names a prerelease names exact code. An installation is offered prereleases only when it
chooses **Prereleases** (or **Developer builds**) in the *Update code* panel, and only
from a code server that publishes them; the default, **Published releases**, never
offers one.

**Action needed** for an installation running 7.0.0-beta.6 or an earlier beta: it
reports the bare version `7.0.0` and does not know about prereleases, so it is offered
neither 7.0.0-beta.7 nor, later, 7.0.0. To move on:

- a **Docker** installation updates its image to `7.0.0-beta.7`, as described in
  [a stack installed from a beta before 7.0.0-beta.7](./install/docker.md#a-stack-installed-from-a-beta-before-700-beta7);
- an installation **updated from the panel** chooses **Developer builds** and installs
  the developer build of 7.0.0 the code server offers (see
  [testing development work on a real installation](./management/updates/updating_code.md#testing-development-work-on-a-real-installation)).
  With **Developer builds** still chosen, it is then
  offered every published build of 7.0.0 — 7.0.0-beta.7 and the later prereleases (from
  a code server that publishes prereleases), and 7.0.0 once it is released — because a
  developer build cannot tell which of them are older than it. Once it runs one of
  them, its panel's **Prereleases** and **Published releases** choices work as usual.
