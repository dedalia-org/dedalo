---
title: An air-gapped install makes no GeoIP download.
type: fixed
audience: admin
date: 2026-11-08
---
The server downloads the free DB-IP country database on its first start and monthly after that. The air-gapped answer (`--no-update-servers`) now also writes `DEDALO_GEOIP_AUTO_UPDATE=false`, so an air-gapped install makes no request to the internet. The download is now documented in the installer reference.
