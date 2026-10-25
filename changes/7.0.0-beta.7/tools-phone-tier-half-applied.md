---
title: Tools on a phone use the phone's own spacing and header height; only part of the phone adjustments were reaching the screen.
type: fixed
audience: user
date: 2026-10-17
---

Every tool panel carries a set of adjustments for small screens: tighter page padding, a shorter header, a smaller tool name. Half of them did not reach the browser — the shared stylesheet declared them *before* the styles they were meant to override, so the desktop values won and each tool kept its desktop padding and header height on a phone. The result was a panel whose content started lower and whose header (which stays pinned while you scroll) took more of the screen than it was designed to.

The panel now uses the phone measurements throughout: the body keeps a half-rem gutter instead of a full one, the header is a little shorter, the tool name sits at the phone size, and the header's controls band still spans the full width with its bottom edge flush with the header. Desktop layouts are unchanged.
