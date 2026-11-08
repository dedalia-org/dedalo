---
title: Lists separate multiple values again instead of gluing them together.
type: fixed
audience: user
date: 2026-11-05
breaking: false
---
A list cell holding several values, such as two dates, showed them run together ("09/06/162825/06/2024") when the field had no separator configured. They are now separated by a comma ("09/06/1628, 25/06/2024"). This affected dates, emails, geolocations and other fields shown as plain text in lists.
