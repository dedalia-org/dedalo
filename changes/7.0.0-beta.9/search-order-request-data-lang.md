---
title: Sorting a list by a translatable field follows your data language.
type: fixed
audience: user
date: 2026-11-22
---
A list sorted by a translatable field (a title, a name) used the installation's
configured data language to compare the values, whatever language the user had
chosen in the menu — a user working in English saw the rows in the order of their
Spanish values. The sort now compares the values in the user's current data
language. A sort that names its own language is unchanged.
