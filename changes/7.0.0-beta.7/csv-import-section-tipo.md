---
title: CSV import guesses the target section from more file names and remembers your correction.
type: changed
audience: user
date: 2026-10-20
---
In the *Import Dédalo CSV* tool, the target section tipo is now read from any word of the file name that has the tipo shape, so names such as `export_Mint_07-10-2026-numisdata6-raw.csv` resolve to `numisdata6` instead of `raw`. When a name holds several tipos, the field offers them as suggestions.

A section tipo typed by hand is remembered in your browser for that file name and comes back after a reload, marked *remembered*; click the mark to forget it. Nothing is stored on the server.
