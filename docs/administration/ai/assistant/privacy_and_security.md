# Privacy & security

> Part of the [AI Assistant](index.md) section · Previous: [Configuration reference](configuration.md) · Next: [Use cases](use_cases.md) · See also: [Users & permissions](../../users_and_permissions.md) · [RAG security](../rag.md)

This is the page that matters most for a real institution. Cultural-heritage archives hold data that ranges from freely publishable to strictly protected — oral testimonies given under promises of confidentiality, personal data, embargoed research. An AI assistant that could read anything, or quietly ship a protected record to a cloud provider, would be unusable in that setting. The Dédalo assistant is built so it **cannot** do either. This page explains the four guarantees and how each is enforced.

The short version:

1. **Same eyes as the human.** The assistant sees exactly what its user could see — same project scope, same record permissions.
2. **The egress gate.** On an external (cloud) model, restricted record content is refused, by default *all* record content, and never reaches the provider.
3. **Propose, never write.** In write mode the assistant drafts a plan; a human confirms it; only then does anything change.
4. **Secrets stay on the server.** The browser never receives an API key, an endpoint, or a provider-native model id.

---

## 1. Same permissions as the human

Every tool the assistant runs executes **under the logged-in browser user's principal** — the same identity, the same access-control checks as if that person had done the action in the normal client. This is not a filter applied after the fact; it is the same engine.

- Reads go through the same search assembler and the same **per-record project-scope filter** every other read uses. A record outside the user's project scope is not "hidden from the assistant" — it is never returned to *that user* by *any* door.
- The identity is **server-authoritative**: it comes from the session, not from anything the browser or the model can set. No tool call can change who the assistant is acting as.
- Consequence: an assistant answer can never contain a record the person could not already open. There is no path by which the AI becomes a second, wider way into the data.

This is why enabling the assistant does not expand anyone's access. It is a new *interface* to what a user can already reach, not a new *permission*.

---

## 2. The egress gate {#the-egress-gate}

The access-control guarantee above governs *what the user (and so the assistant) may read*. A second, independent question is: *once the assistant has legitimately read a record, may that record's text be sent to the model provider?* For a **local** model the answer is always yes — nothing leaves your infrastructure. For an **external** model (a cloud API), the answer is governed by the **egress gate**.

### The default: external models get no record content

By default (`DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT=false`), a conversation running on an external-egress model may:

- use the **discovery / structure** tools (list sections, describe a section's fields, resolve a name to a `tipo`, validate a path) — these return ontology *structure*, not record data; and
- converse and reason;

but **every record-content tool call is refused** with a coded `mcp.egress_restricted` error, and the assistant is told to answer without it or to suggest switching to a local model. In this posture, no record content ever reaches the cloud.

### Opening it up, section by section

Many institutions have a mix: a public numismatics catalogue that is fine to send to a capable cloud model, and a protected oral-history collection that must never leave. Two settings express exactly that:

- `DEDALO_AGENT_ALLOW_EXTERNAL_PROVIDER_DEFAULT=true` — external models *may* receive record content…
- `DEDALO_RAG_EXTERNAL_PROVIDER_FORBIDDEN_SECTIONS=oh1,memory9` — …except records in these sections, which are **never** sent externally.

The forbidden-sections list is **shared with the [RAG subsystem](../rag.md)** on purpose: it is one classification of *the data*, honoured by both AI surfaces, so a section restricted for one is restricted for the other.

### How the gate actually works (both ends)

The gate is enforced inside the agent loop — the exact point where a tool result would enter the model's context — and it checks **both** the tool call and its result, because a section can be involved without being the obvious target:

- **On the call.** Before a record-content tool runs, the gate collects *every* section named anywhere in its input and refuses if any is restricted. This matters because a search filter can walk a path into another section: rows come back from the public section, but the filter *tests values in a restricted one* — an inference oracle ("does a record in the protected section match X?"). Naming a restricted section anywhere in the call is refused.
- **On the result.** After a read runs, the gate walks the *result* for every section it references and refuses if any is restricted. This catches the case where reading a public record resolves the **labels of linked records** in a protected section through its portals — a protected informant's name reached sideways through a public catalogue entry.

Both directions **fail closed**: a call that names no classifiable section, or whose classification errors, is refused rather than allowed.

!!! note "Mechanically enforced coverage"
    Which read tools carry record content (and are therefore gated) versus which return only ontology structure (and are exempt) is not a hand-maintained list that can drift. A test (`agent_egress_tripwire`) iterates every read tool and fails the build if a new one is neither gated nor explicitly exempt-with-a-reason. A future tool cannot silently start shipping record content to a cloud model.

### The user's own words are not gated

The person's question and any images they attach *do* go to the chosen model — that is the user consciously choosing an external model for this conversation. The gate protects **repository content**, not the user's own input. A user who types a protected name into a cloud-model chat has sent it themselves; the gate stops the *archive* from doing so behind their back.

---

## 3. Write mode: propose → confirm → apply {#write-mode-propose--confirm--apply}

When write mode is enabled (`DEDALO_AGENT_ALLOW_WRITE=true`), the assistant can help create and edit records — but the safety model is strict:

- **The loop that talks to the model never writes.** In write mode the model is given the read tools plus one synthetic tool, "propose a change plan". A valid proposal *ends the turn* and returns a resolved **change plan** — an ordered list of operations, each with the exact tool, the exact arguments, and a one-line summary. Nothing has been written.
- **A human confirms the resolved plan.** The chat shows a confirm card: the plan summary, and one row per operation showing both the summary *and the actual arguments that will execute* (not just the model's prose description — so a plan can't describe one change and perform another). You click Apply or Cancel.
- **Apply re-validates everything.** On confirm, the client sends the plan back with a hash. The server recomputes the hash (so what executes is byte-for-byte what you confirmed), then **re-runs every permission and scope gate** before executing each operation sequentially, as ordinary human-style edits (transaction-wrapped, audited). Each write also re-checks that the user can access that specific record.

Two more walls:

- **Global admins can't drive writes.** Write capability is refused to global-administrator / superuser sessions. The agent reads untrusted record content as part of its work; under an ambient admin identity, a prompt injection in that content could try to drive a privileged write. Use a scoped, least-privilege account for write work.
- **The write-scope tripwire.** A test mechanically iterates every write tool and fails the build if one skips the per-record scope check. A new write tool cannot ship without it.

---

## 4. The model catalog never leaks secrets {#the-model-catalog-never-leaks-secrets}

The browser is treated as untrusted. What the client learns about models comes from the `agent_models` action, which returns a **secret-free projection**: for each model only its `id`, `label`, `egress` class, `vision` flag, and whether it is the default. The endpoint URL, the env-var name of the key, and the provider-native model id **never reach the browser**.

This closes a real, historical hole: the previous (pre-rewrite) assistant stored a server model's API key in the tool's configuration record, flagged as client-visible — so the key was delivered to every browser. The rewrite removed that entirely; a test asserts the tool's configuration stays secret-free so it cannot regress.

One related guard: a catalog entry's `api_key_env` (which *names* the env var holding a key) must end in `_API_KEY`, `_KEY` or `_TOKEN`. Because that value is sent as an `Authorization` header to the entry's endpoint, an unconstrained name in a carelessly copied catalog could turn an unrelated secret — a database password — into an outbound header. The suffix constraint blocks that footgun.

---

## The threat model, briefly

| Concern | What stops it |
|---|---|
| AI reads data the user can't | Same principal, same per-record ACL as the human — enforced in the engine, not filtered after |
| Protected record reaches a cloud provider | Egress gate (default-deny), both on the call and the result, fail-closed; forbidden-sections list |
| Filter/path used as an inference oracle over a restricted section | The call-side gate classifies *every* section named in the input |
| Prompt injection in record content drives a write | Loop can't write (propose-only); apply re-validates; global-admins can't write |
| Confirmed plan differs from what runs | Hash over the plan; apply recomputes it; the confirm card shows real args |
| Secrets delivered to the browser | Secret-free `agent_models` projection; `api_key_env` suffix constraint |
| Session hijack / cross-site | Normal Dédalo session + CSRF gates apply to every assistant action (none is exempt) |

Each of these controls is covered by a dedicated automated test, so a regression in any of them fails the test suite rather than shipping silently.
