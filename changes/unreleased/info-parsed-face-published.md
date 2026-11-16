---
title: Published information fields carry the readable value the record page shows (a duration as text, not its internal object); on-demand widgets are published too.
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-info-parsed-face-published
---
A published column mapped onto an information field's widget (`parser_info::widget`) now
carries the widget's **readable** value — the one the record page and the export show. The sum of
dates widget publishes `2 months 15 days` (in the publication's main language) where it used to
publish the internal interval object as JSON. Widgets whose readable face is their computed value
(state, calculation, media icons…) publish unchanged. The user-activity widget, loaded on demand in
the record page, is now computed and published as well, as it was before the engine change.

Republish the elements carrying such columns to refresh the public tables; the mapping of the
mdcat duration column is set on the master ontology once this release is installed.

