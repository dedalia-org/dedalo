---
title: The Local AI translator no longer loses, reverses or invents marks silently
type: fixed
audience: user
date: 2026-11-22
---
Before, when the in-browser translation model dropped an index mark, a time code or another mark, the mark simply vanished from the translated text. When it reversed an opening and closing mark, they were saved reversed. Both runs reported *Translation completed*. Now marks, links, superscripts and other formatting are kept out of the model's reach and put back unchanged, and long texts are translated a few sentences at a time. A mark the model dropped is placed by the translator itself, and reversed pairs are put back in order; the result is saved with **Translation saved — check the marks** and a line saying what was moved. A mark that is still missing, appears twice or is not in the source, a part of the text the model failed on, or a model that repeated itself instead of translating stops the run: nothing is saved, the target keeps its previous text and the panel shows **Translation needs review before saving**. Text written by the model is always stored as text, never as markup. Stopping a run while its last part is being translated no longer saves it. The multi-language translator names every language saved with warnings in its summary. See [Translate a field](./using/tools/using_lang.md).
