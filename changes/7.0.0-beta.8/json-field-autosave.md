---
title: JSON fields save when you leave them, like every other field.
type: changed
audience: user
date: 2026-11-06
---
Before, a change in a JSON field was not saved when you clicked out of it, but it was saved later, the next time you clicked into any field, which made saving look random. Now a JSON field saves when you leave it, like every other field; only content that is valid JSON is saved, and emptying the editor clears the value. Going back to the saved value also clears the unsaved state, so the Save button dims again.
