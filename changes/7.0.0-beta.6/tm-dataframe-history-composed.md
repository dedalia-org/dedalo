---
title: A field's history now keeps its dataframe with it, and restoring an entry restores both.
type: fixed
audience: user
date: 2026-09-28
wc: WC-2026-09-27-bulk-revert-undo-log
---
A field with a [dataframe](./core/components/component_dataframe.md) — informants with their
role, a value with its certainty — stores the two apart, but they mean one thing. Until now
the history recorded them apart as well: the field's entries held no frames, so restoring
an entry left the frames as they were today. The field's history now holds both, in two
kinds of entry: an entry of a **language** holds that language's value, and an entry marked
**lg-nolan** holds the value that has no language (a field that is not translatable, or the
base form of a name with transliterations — *Augustus*, beside *Αύγουστος* in Greek) and
**all** the frames. A change to a frame adds ONE lg-nolan entry to the field's own history
(the dataframe has none), never a copy per language, and the history of a language lists
its own entries and the lg-nolan entries together. It does not matter whether the value or
the frame was saved first: the preview of any entry shows the whole state at that moment —
the language's value and the frames as they were — and restoring it returns that state:
a language entry puts its language back with the frames of that moment, an lg-nolan entry
puts its frames back. The field's other languages, and another field sharing the same
dataframe, keep theirs; a frame of an item deleted since is never put back.
This holds for every kind of field a dataframe can hang from — a list of linked records, a
text in several languages, a transliterable name, a number, a date, a web address with its
label. Translations and duplicated records record their history the same way. Reverting a
batch run does the same for every field it changed, language by language.
Entries recorded by Dédalo v6 are read the same way: an entry that carries frames gives its
language value and the frames of that moment, and a dataframe such an entry is silent about
was empty then; a v6 language entry with no frames at all takes the frames recorded before it.
Removing an item of any such field — a text, a number, a date, a web address, not only a
list of linked records — now removes its frames too. See
[Time machine](./using/tools/using_time_machine.md).
