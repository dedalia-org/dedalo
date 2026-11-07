---
title: A write sent with an unusable retry count is no longer resent without its duplicate-protection key.
type: fixed
audience: developer
date: 2026-11-06
---
The browser's request layer decided whether to stamp a request with the idempotency key that stops a retry from creating a second record from one value, and how many times to send it from another. A request sent with a missing or invalid retry count (for example `undefined` or `null` passed explicitly, which overrides the default) was therefore sent up to five times without the key, and a write resent that way could create a second record. The count is now read once, an unusable value means the default of five attempts, and every resend of a write carries the key. A caller that wants a single attempt still passes `retries: 1`.
