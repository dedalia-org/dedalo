---
title: A term added from the thesaurus tree is no longer marked descriptor and indexable automatically.
type: changed
audience: user
date: 2026-11-22
wc: WC-2026-08-09-record-birth-defaults
---
The "+" of the thesaurus tree used to set *descriptor* and *indexable* to Yes on every new
term, even where the thesaurus defines another default (a term defined to start as a
non-descriptor was created as a descriptor). A new term now starts with exactly the
defaults its thesaurus defines. Where the thesaurus defines none — the case for the
standard thesauri — both fields start empty: set them on the new term yourself. Until
*descriptor* is set, the term is not counted as a descriptor or a non-descriptor: when none of
a term's children has it set, the term shows no arrow to open its children after the page is
reloaded, and the new term is reached from its section's list until you set it.
