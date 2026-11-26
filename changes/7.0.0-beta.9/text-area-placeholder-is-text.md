---
title: An empty text area shows the other language's text as plain text, and list previews load their images from the media server.
type: fixed
audience: user
date: 2026-11-21
wc: WC-2026-11-21-text-area-edit-fallback-is-text
---
When a text area has no text in the language you are editing, the editor shows the text of
another language as a grey placeholder. That placeholder carried the whole stored text: timecode
and indexation marks appeared as bracketed codes and the text was not shortened. It is now the
readable text only, shortened to 700 characters.

On installations that serve media from a separate address, a list cell showing another
language's text loaded its embedded images from the wrong address (they appeared broken); they
now load like every other image.
