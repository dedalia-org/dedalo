---
title: Information fields export every widget, the user-activity widget included; they are computed-only fields the cache and the CSV import leave alone.
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-info-derived-async-published, WC-2026-11-13-calculation-total-records-no-frontier
---
An information field whose widget is loaded on demand in the record page (the user-activity
widget) exported an empty cell and published an empty column. The export now computes it like
any other widget — the cell holds the activity totals — and the publication follows in the same
release. The record page is unchanged: the widget still loads on demand there.

Information fields are now declared as **computed-only**. Two consequences: the cache
regeneration tool skips them (there is nothing stored to regenerate — the tool says so in its
summary), and a CSV import that maps a column onto one is refused with a message naming the
column, instead of writing a value nobody ever reads.

A calculation field (a sum, a mean, a total over the linked records) totals **every** record its
definition reaches, whatever the reader's project scope admits: the mean over a type is the mean
over all its items, the same number for every user who may see the field. Who may see the field is
decided at the field, as before. This was already so; it is now stated as the rule.
