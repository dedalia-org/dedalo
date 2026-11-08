---
title: AI entry points are hidden when the installation has no model.
type: changed
audience: user
date: 2026-10-29
---
The assistant icon is no longer shown unless the installation has an AI model enabled. Semantic search is shown only when a real embedding sidecar is configured; without one it is hidden instead of falling back to a placeholder. Object identification is hidden for now while it is being redesigned. Nothing else changes for installations that already have a model.
