---
title: "Diffusion: a `text_format` pattern no longer strips a leading `/` (or other separator) from the value itself."
type: fixed
audience: admin
date: 2026-11-24
---
The `text_format` parser trims separators left over when a placeholder is empty. It also trimmed the first or last character of a real value when that character was `/`, `-`, `,` or `|`, so a media path published through a pattern lost its leading slash (`dedalo/media/…` instead of `/dedalo/media/…`, next to columns that kept it). Only the pattern's own separators are trimmed now. Re-publish the affected sections to correct the published values.
