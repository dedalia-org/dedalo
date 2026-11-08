---
title: Geolocation maps load faster
type: changed
audience: user
date: 2026-10-30
---

The map component fetches fewer files before showing a map: the colour picker library loads only when a layer's colour swatch is first opened, turf and the language table load in parallel with Leaflet, and the search and mini/text views load only when used.
