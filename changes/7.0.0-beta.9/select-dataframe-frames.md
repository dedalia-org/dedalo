---
title: A select with a dataframe (such as the uncertainty of a coin's discovery method) shows and saves its frame again.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-select-dataframe-subdatum
---
A select field whose configuration declares a dataframe slot showed no frame widget in the edit form, so its
qualifier (for example the uncertainty rating of a coin's discovery method) could be neither seen nor set. The
server now sends the frame of every selected value with the field, as it did before, on the record form, on a
field refresh and right after a new pick. Frames already stored were never lost; they appear again.
