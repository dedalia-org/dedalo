---
title: Tools can look up places, parcels and elevations through one checked door.
type: added
audience: developer
date: 2026-11-06
---
The engine gains a closed table of public geographic lookups a tool can ask for: place names and reverse geocoding (Nominatim), the Digital Atlas of the Roman Empire (DARE), Spanish cadastral parcels (Catastro), Spanish administrative units (IGN) and elevations (open-elevation). A tool names a service and passes its parameters; it never passes an address, and each parameter is checked against that service's grammar before anything is sent. Each provider is called at the pace it asks for (Nominatim at most once a second for the whole installation), identical simultaneous questions are one call, Nominatim's answers are kept for an hour, and every failure is a typed error that names no address. No tool of this release uses it yet, so nothing changes for a user.

Two things for administrators. The server needs outbound HTTPS to `nominatim.openstreetmap.org`, `imperium.ahlfeldt.se`, `ovc.catastro.meh.es`, `www.ign.es` and `api.open-elevation.com` for a tool that uses it. And what a cataloguer asks leaves the server: Nominatim and open-elevation receive the place name or the coordinates, so the position of a site that must stay private should not be sent to them. The page [geo_services](./core/system/geo_services.md) lists what each provider receives and which of their terms were checked.
