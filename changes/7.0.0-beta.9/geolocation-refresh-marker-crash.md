---
title: Refreshing a map with drawn points no longer throws errors or loses its layer control.
type: fixed
audience: user
date: 2026-11-09
---
When a geolocation field was refreshed (the map reload button, or the record re-rendering), its
drawn points were added back to the map that had just been removed: the console showed
`Cannot read properties of undefined (reading 'appendChild')` once per point, and on maps with
several base layers the layer selector disappeared. The rebuilt map now gets its own layer
control, and a map whose field is refreshed while it is still loading is no longer built twice.
