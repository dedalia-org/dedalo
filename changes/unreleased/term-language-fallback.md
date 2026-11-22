---
title: A thesaurus term missing in your language now shows in another of your project languages, marked as untranslated, and shows every value it holds.
type: fixed
audience: user
date: 2026-11-22
wc: WC-2026-11-22-term-fallback-chain
---
When a term has no value in the language you work in, Dédalo looks for it in the thesaurus's own language, then in the language-neutral value, then in each of your project languages in order, and shows the first one it finds. Before, the tree, portals and exports each followed a different rule: a term could show empty in one place and in another language elsewhere. In the tree, a term shown from another language is highlighted as untranslated; exports and publications receive the plain text, never the highlight. A value held only in a language that none of your projects uses is no longer shown.

A term that holds two values in the same language now shows both, separated by ` | `, instead of only the first one. The labels of the indexation groups in the tree now follow your interface language.
