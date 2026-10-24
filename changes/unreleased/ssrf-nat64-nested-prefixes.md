---
title: Outbound fetches judge an IPv6 address through every NAT64 prefix that holds it, so nested prefixes cannot reach an internal address.
type: security
audience: admin
date: 2026-10-21
---
Before the server fetches a URL on a user's behalf, it judges an IPv6 address that carries
an IPv4 address through NAT64 by that IPv4 address. NAT64 prefixes can sit one inside
another: two translators, a name server answering with two addresses, or an outer and an
inner prefix declared in `DEDALO_NAT64_PREFIXES`. The same address then carries a different
IPv4 address through each, and the check read only the first prefix in its list. Depending
on the order, an address could pass as a public site while, through the inner prefix the
network actually routes by, it reached the cloud metadata endpoint.

Now the address is read through every prefix that holds it, the most specific first, and it
is refused if any of those readings is not a public address. Nothing to configure; the
prefixes are declared as before (see
[Declaring the NAT64 prefixes](./config/config.md)).
