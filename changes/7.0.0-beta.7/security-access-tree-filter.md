---
title: The profile permission tree can be filtered by name or tipo.
type: added
audience: user
date: 2026-10-24
---

A profile's **Access and permissions** tree lists the whole ontology, and a node
several levels down (a component inside a section inside an area) was hard to
find: you had to open the branches one by one.

The tree now has a search box above it. Typing part of a node's **name** or its
**tipo** keeps that node together with the path to it, and opens the branches on
the way down, so the permission radios are in front of you instead of hidden.

- Matching ignores case and accents (`administracion` finds `Administración`).
- Several words must all match the same node (`user name`, not one each).
- Matching nodes are highlighted in yellow, so a result is easy to spot among the
  open branches that lead to it.
- The counter shows how many nodes match; a very broad query renders the first
  500 matches and says so — type more to narrow it.
- The filter only changes what is *shown*. Permission values, and the propagation
  of a checkbox or a global `x / r / rw` radio, still apply to every node,
  visible or not. Clearing the box restores the tree exactly as you had it.
- Jumping to a section from **Latest changes** clears the filter: that jump exists
  to show you the section, and a query could hide it.
