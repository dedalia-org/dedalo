---
title: A transliteration saved in its language no longer replaces the base form.
type: fixed
audience: user
date: 2026-09-28
---
A field that keeps a base form and per-language versions — a person's name such as
*Augustus* with its Greek form *Αύγουστος* ([component_input_text](./core/components/component_input_text.md)
with `with_lang_versions`) — now stores a version saved in a language beside the base
form. Before, editing the field in Greek, importing a CSV cell with both forms, or running
*Propagate component data* or *Update cache* on it replaced the base form with the
version, and *Update cache* could even create a base form that never existed. Each form
now also has its own entry in the [Time machine](./using/tools/using_time_machine.md) history, listed
while you work in that form's language; its preview shows the base form, and restoring it puts
the form back.
