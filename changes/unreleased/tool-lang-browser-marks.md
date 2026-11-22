---
title: The Local AI translator no longer loses or reverses marks silently
type: fixed
audience: user
date: 2026-11-22
---
Before, when the in-browser translation model dropped an index mark, a time code or another mark, the mark simply vanished from the translated text. When it reversed an opening and closing mark, they were saved reversed. Both runs reported *Translation completed*. Now the translator asks the model again for a dropped mark, then places the mark itself if it has to, and puts reversed pairs back in order. It saves the result with **Translation saved — check the marks** and says what it moved. A mark it still cannot place, or one the source does not have, stops the run: nothing is saved, the target keeps its previous text and the panel shows **Translation needs review before saving**. This applies to the single-field and the multi-language translators. See [Translate a field](./using/tools/using_lang.md).
