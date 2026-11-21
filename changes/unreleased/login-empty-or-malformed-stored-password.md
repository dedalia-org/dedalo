---
title: Login reads an empty or malformed stored password the same way everywhere
type: fixed
audience: admin
date: 2026-11-21
wc: WC-2026-11-19-legacy-aes-lazy-rehash-retired
---

The login, the legacy-password count and the conversion each had their own idea of which stored values are a Dédalo v6 password, and they disagreed on two shapes.

An account whose stored password is empty text is now treated as having no password by all three: the login refuses it and the Activity section records the attempt as a user that does not exist, where it used to say *legacy password hash* while the count did not include it. An account whose stored password is not text at all (a number, a list) is now refused as a legacy value and counted as one, where the login used to fail with a server error. What the person at the login form sees is unchanged: the same refusal as for any wrong user or password.
