---
title: Calculated fields (totals, periods, amounts, date sums) compute again
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-calculation-widget-port
---
Fields computed by a `calculation` widget showed nothing as soon as the fields they add up held a value: totals of numbers, periods in years, months and days, grant amounts, euro conversions and dates plus a period. They now compute every formula the ontology declares, including sums over the records of a portal and chains of calculated fields. A calculation whose definition the engine cannot run (an unknown formula, a field that cannot be summed, a calculation that depends on itself) now reports an error instead of showing an empty field. Two grant-amount cases still report an error until a pending decision is made: an amount over zero days, and the major-grant amount of the section that the earlier engine treated specially.
