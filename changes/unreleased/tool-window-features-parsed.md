---
title: A tool's window size and position are read as data, never run as code
type: security
audience: developer
date: 2026-11-19
wc: WC-2026-11-19-window-features-grammar
---

A tool's registration can say where and how large it opens (`properties.windowFeatures`). A value written as `"return screen.width -760"` used to be run as JavaScript in the page of every user who opened the tool, so anyone able to edit a tool's registration could run script there.

The value is now read against a fixed grammar and nothing in it is executed. A window accepts `left`, `top`, `width` and `height` as a number or as that same relative form — one screen or window dimension, plus or minus a whole number — and a modal accepts its size properties (`width`, `maxWidth`, …). Every tool shipped with Dédalo opens exactly as before. A registration that uses anything else no longer opens: the browser console names the key to correct. The accepted forms are listed in [register.json](./development/tools/register_json.md#propertieswindowfeatures).
