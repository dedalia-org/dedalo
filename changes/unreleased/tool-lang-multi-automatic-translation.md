---
title: The multi-language tool's **Automatic translation** works: it offers the same engines as the single-language tool.
type: fixed
audience: user
date: 2026-11-10
wc: WC-2026-11-10-translation-empty-result
---
The **Automatic translation** button in the multi-language tool did nothing: the tool had no translation engines of its own. It now uses the engines configured for the single-language translation tool (`tool_lang`) — the same list, the same server settings — so one configuration serves both. The engine selector and its local-AI options are shared by both tools; where no engine is configured the button is no longer shown.

Running it no longer stops with "Source component not available": the tool read every language as empty, so it always refused. When the language the tool opened in has no text, it now translates from the first language that does, and highlights it as the source.

To translate into one language only, use that language's own translate button (in the component's top button bar): it translates the current source into it. Clicking into a language no longer makes it the source — only editing it does — so its own button works. It does nothing when the source is empty (an empty paragraph counts as empty), so it can no longer blank a language. While a language is being translated it is dimmed with a spinner, clear of its buttons. A double click on **Automatic translation** no longer closes its dialog unseen. The tool's messages no longer overlap each other, look like the application's other notifications and can be closed. The "translate into all languages?" dialog now has the same layout and spacing as the application's other confirmation dialogs.

When the translation service does not support a language (for example Basque with Babel), the tool used to report "Translation completed" and leave that language blank — replacing whatever it held. Now nothing is written: the language keeps its text and shows "The translation service returned no text: it probably does not support this language". "Translate all" names the languages that failed in its summary.
