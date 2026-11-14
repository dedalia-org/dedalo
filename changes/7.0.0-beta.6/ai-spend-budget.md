---
title: Every AI request now counts against daily limits set per user and per profile, and generated answers need their own permission.
type: security
audience: admin
date: 2026-10-12
breaking: true
wc: WC-2026-10-01-ai-spend-budget, WC-2026-10-12-ddengine-removed
---
Until now any logged-in user could run the assistant, ask for generated answers and run semantic searches without any limit, so one session could exhaust an installation's model budget (or its local GPU). Every request that calls a model is now checked against the user's daily limits before the model is called: assistant runs, model tokens, semantic-search queries, and vision calls of the identification tool. When a limit is used up the request is refused with a message saying when it resets (midnight UTC). Nobody is exempt, administrators and root included.

The limits are set in the **AI usage** group of each profile (Administration → Profiles) and, to override the profile for one person, of each user (Administration → Users). Each of the four limits is resolved on its own: the user's value when it is filled in, otherwise the profile's, otherwise 0. A limit of 0 refuses every request of that kind; there is no "unlimited" value. A user cannot raise their own limit: on their own user record the AI limits are read-only, whatever their profile allows (administrators with full access excepted). The day's usage of every user is listed in the **AI usage** section under Administration. See [AI spend limits](./administration/ai/assistant/configuration.md#ai-spend-limits).

**Action needed:** a fresh database is required for this beta: databases created by an earlier beta hold engine-written ontology rows that this version no longer uses, and they are not migrated. On the new installation, set the AI limits on the profiles (or users) that should use AI features, since all limits start empty and every AI request is refused until then. Generated answers over the collection also require the **Generated answers** tool permission (`tool_rag`): run *Register tools* after the update, then grant it in the profile editor to the profiles that should use generated answers. Semantic search does not need it.
