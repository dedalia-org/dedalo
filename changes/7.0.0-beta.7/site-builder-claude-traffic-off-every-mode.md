---
title: Site builder: a Claude Code turn turns off its auto-updater and telemetry in every confinement mode, not only when confined
type: security
audience: admin
date: 2026-10-21
---
A site builder turn run by Claude Code now always starts the agent with its
auto-updater and its non-essential traffic (telemetry, error reporting) switched
off. Before, those two switches were applied only to a turn confined under its
site identity: on an instance declared `AGENT_CONFINEMENT=none`, a Claude Code
turn ran with the auto-updater on — which could replace the very binary the
daemon had checked before the turn — and sent traffic to hosts the instance's
plan does not name. opencode turns already had their equivalent switches in
every mode. Nothing to configure.
