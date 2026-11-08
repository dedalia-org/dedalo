---
title: Tools can now explain a refusal in the user's own language.
type: added
audience: developer
date: 2026-11-06
wc: WC-2026-11-06-tool-reason-key
---
A tool that refuses a request can now say why, in a sentence it ships with its own translations, instead of a generic message. The tool declares a closed list of reasons in its server module, each with its English fallback sentence, and throws an existing error code with one of them (`details.reason_key`); the browser shows the tool's label for that reason in the user's language, and the declared English sentence when it has no translation, so a refusal always reads as one notice. The sentence is declared once, beside the key, and the server supplies it: a reason the tool did not declare, a refusal that brings any other sentence (an upstream's text), and a refusal a tool embeds in its answer without the same check are rejected, and a tool that declares reasons does not build error bodies by hand. A test checks that every declared reason has a label in each language the tool carries, that no label asks for a value the error cannot supply, and that the server really serves every tool behind that check. A tool's own progress panel (`render_stream({tool})`) shows the reason when a background run is refused. One code is retryable, `tool.source_unavailable`; a tool refuses with it from a read-only action so the browser's automatic resend does not hide the reason. See [error handling](./core/system/errors.md).
