---
title: A field's dataframes are the same set when it is shown, saved, restored and exported.
type: fixed
audience: user
date: 2026-11-21
wc: WC-2026-08-09-time-machine-restore-replays-paired-dataframe-frames, WC-2026-08-09-export-raw-dataframe-own-column
---
A text or date field can carry dataframes (extra values paired with each of its items, such as
a certainty rating). Which dataframes a field has was answered in two ways: saving, deleting and
the Time Machine used every dataframe the field declares, while the edit form and the raw export
only used the ones defined directly under the field in the ontology. A dataframe declared through
the field's own configuration was therefore kept up to date and restored, but never shown and
never exported. All four now use the same set.

For administrators: the raw (`dedalo_raw`) export gains a column for each such dataframe, and for
the label dataframe of IRI fields. Ontology authors: `has_dataframe: true` is still what switches
a text field's dataframes on.
