---
title: An emptied translation shows the other-language text again
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-lang-fallback-judges-emptiness
---
When you emptied a field's text in one language (for example deleted the English title of a
record that also has a Spanish one), Dédalo kept the empty English entry and treated it as
"there is a value": the field showed blank instead of the text in another language. The
same happened when the empty entry was in the main language — the other languages were
never tried.

Now an entry that is empty, holds only spaces, or (in a rich-text field) only an empty
paragraph left by the editor counts as no text. The edit field shows the other-language
text as its grey hint again (a view-only field shows it highlighted), and lists, selector labels, project and user names, related
lists, exports and AI search use the other-language text. A value of `0` still counts as a
value.

Rich-text fields in a section **list** still show a blank cell when their text in the
current language was emptied; whether they should show the other-language text there too
is still open.
