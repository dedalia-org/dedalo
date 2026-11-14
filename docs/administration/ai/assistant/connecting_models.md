# Connecting models

> Part of the [AI Assistant](index.md) section · Previous: [Installing & enabling](install.md) · Next: [Configuration reference](configuration.md) · See also: [Privacy & security](privacy_and_security.md)

The assistant does not ship with a model. **You** decide which model(s) it may use by writing a **catalog** — the `DEDALO_AGENT_MODELS` setting. Each entry in the catalog is one model the user can pick per conversation, and each carries a **privacy class** (`local` or `external`) that drives the [egress gate](privacy_and_security.md#the-egress-gate). This page is the complete guide to that catalog.

Two kinds of model can be connected:

- **External API models** — a cloud provider such as Anthropic. Fast to set up, most capable, but data sent to them leaves your infrastructure.
- **Local / self-hosted models** — an OpenAI-compatible endpoint you run yourself (Ollama, vLLM, LM Studio, llama.cpp server…). Slower to set up and generally less capable, but **nothing leaves the building**. This is the path for institutions with private "Memory" collections.

You can offer both at once and let each conversation choose.

---

## The zero-config path (one cloud model)

If you set only a key, the assistant builds an **implicit catalog** of a single Anthropic model:

```bash
ANTHROPIC_API_KEY=sk-ant-...
# optional: pick the model (default claude-opus-4-8)
AGENT_MODEL=claude-opus-4-8
```

This is equivalent to a one-entry catalog classed `external`. It is the quickest way to try the assistant. To offer a choice, or to connect a local model, write an explicit catalog.

---

## The catalog: `DEDALO_AGENT_MODELS`

`DEDALO_AGENT_MODELS` is a **JSON array** in `../private/.env`. Each entry is one selectable model:

```bash
DEDALO_AGENT_MODELS=[{"id":"claude","label":"Claude Opus 4.8","provider":"anthropic","model":"claude-opus-4-8","egress":"external","vision":true},{"id":"llama-local","label":"Llama 3.1 (local)","provider":"openai_compatible","model":"llama3.1:70b","endpoint":"http://127.0.0.1:11434/v1/chat/completions","egress":"local","timeout_s":120}]`
```

The **first entry is the default** model (pre-selected in the picker). Read for a moment as pretty-printed JSON:

```jsonc
[
  {
    "id": "claude",                    // the id the client selects; [a-z0-9_-], 1–64 chars, unique
    "label": "Claude Opus 4.8",        // shown in the picker, 1–120 chars
    "provider": "anthropic",           // "anthropic" | "openai_compatible"
    "model": "claude-opus-4-8",        // the provider-native model id (never sent to the browser)
    "egress": "external",              // "external" | "local" — the privacy class
    "vision": true                     // may receive images (default: anthropic true, openai false)
  },
  {
    "id": "llama-local",
    "label": "Llama 3.1 (local)",
    "provider": "openai_compatible",
    "model": "llama3.1:70b",
    "endpoint": "http://127.0.0.1:11434/v1/chat/completions",  // required for openai_compatible
    "egress": "local",                 // required for openai_compatible — you declare it
    "timeout_s": 120                   // idle timeout for the local endpoint (max 3600)
  }
]
```

### Every field

| Field | Required | Rules | Notes |
|---|---|---|---|
| `id` | yes | `^[a-z0-9_-]{1,64}$`, unique | the stable id the client picks by |
| `label` | yes | 1–120 chars | the human name in the picker |
| `provider` | yes | `anthropic` \| `openai_compatible` | which provider driver to use |
| `model` | yes | 1–200 chars | the provider-native model id; **never leaves the server** |
| `endpoint` | for `openai_compatible` | a URL | the chat-completions endpoint |
| `egress` | for `openai_compatible` | `external` \| `local` | the privacy class (see below) |
| `api_key_env` | no | must **end in** `_API_KEY`, `_KEY` or `_TOKEN` | *names* another env var holding the key |
| `vision` | no | boolean | default `true` for anthropic, `false` for openai_compatible |
| `max_tokens` | no | positive int | per-turn output cap for this model |
| `timeout_s` | no | int, ≤ 3600 | transport idle timeout (openai_compatible) |

### The egress class is the privacy decision

`egress` tells the assistant whether a conversation on this model may receive restricted record content:

- **`external`** — the model runs off your infrastructure (any cloud API, or a self-hosted endpoint you deliberately mark external). Record content is subject to the [egress gate](privacy_and_security.md#the-egress-gate): by default it is **withheld**.
- **`local`** — the model runs on infrastructure you control, so data never leaves. Local conversations are **never gated**; the model may read anything its user could read.

Two rules the catalog enforces so this can't be mis-set by accident:

- An `anthropic` entry is **forced** to `egress: external` — an Anthropic API call always leaves the host, so declaring it `local` is rejected as a config error.
- An `openai_compatible` entry **must declare** `egress` explicitly — you cannot leave it ambiguous, because only you know whether `http://some-host:8000` is inside your walls.

!!! danger "'local' means you host it"
    Marking an endpoint `local` is a claim that the endpoint runs on trusted infrastructure and does not forward data elsewhere. The assistant takes you at your word: a `local` conversation bypasses the egress gate. Do not mark a proxy to a cloud provider `local`.

---

## Connecting a cloud model (Anthropic)

```bash
DEDALO_AGENT_HTTP_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-...
DEDALO_AGENT_MODELS=[{"id":"claude","label":"Claude Opus 4.8","provider":"anthropic","model":"claude-opus-4-8","egress":"external","vision":true}]
```

The key comes from `ANTHROPIC_API_KEY` by default. To use a different env var (e.g. a per-model key), name it with `api_key_env` — but the name must end in `_API_KEY` / `_KEY` / `_TOKEN`, because that value becomes an `Authorization` header and an unconstrained name could turn any secret into an outbound header (see [Privacy & security](privacy_and_security.md#the-model-catalog-never-leaks-secrets)).

## Connecting a local model (Ollama / vLLM / LM Studio)

Any server that speaks the **OpenAI chat-completions API with tool calling** works. Point the entry at its `/v1/chat/completions` endpoint and mark it `local`:

=== "Ollama"

    ```bash
    # ollama serve  → http://127.0.0.1:11434
    DEDALO_AGENT_MODELS=[{"id":"local","label":"Llama 3.1 (local)","provider":"openai_compatible","model":"llama3.1:70b","endpoint":"http://127.0.0.1:11434/v1/chat/completions","egress":"local","timeout_s":120}]
    ```

=== "vLLM"

    ```bash
    # vllm serve <model> --port 8000
    DEDALO_AGENT_MODELS=[{"id":"local","label":"Local vLLM","provider":"openai_compatible","model":"my-model","endpoint":"http://127.0.0.1:8000/v1/chat/completions","egress":"local","api_key_env":"VLLM_API_KEY"}]
    ```

=== "LM Studio"

    ```bash
    # LM Studio local server → http://127.0.0.1:1234
    DEDALO_AGENT_MODELS=[{"id":"local","label":"LM Studio","provider":"openai_compatible","model":"local-model","endpoint":"http://127.0.0.1:1234/v1/chat/completions","egress":"local"}]
    ```

!!! warning "The local model must support tool calling"
    The assistant works by calling tools (search, read, resolve…). A model that cannot emit tool/function calls will loop without ever finding anything. Choose a tools-capable model and, in your local server, enable its tools/function-calling mode. The assistant tolerates common local-server quirks (arguments arriving as an object instead of a JSON string, the whole tool-call in one final chunk, a missing call id), but it cannot invent a capability the model lacks.

---

## Offering a choice: private local + capable cloud

The most common real-world setup gives the user both, and lets them decide per conversation based on what they are working on:

```bash
DEDALO_AGENT_HTTP_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-...
DEDALO_AGENT_MODELS=[
  {"id":"local","label":"Llama 3.1 (local, private)","provider":"openai_compatible","model":"llama3.1:70b","endpoint":"http://127.0.0.1:11434/v1/chat/completions","egress":"local"},
  {"id":"claude","label":"Claude Opus 4.8 (external)","provider":"anthropic","model":"claude-opus-4-8","egress":"external","vision":true}
]
```

(Write that as a single line in `.env` — it is shown multi-line here only for reading.)

The picker shows both, each badged **local / private** or **external service**. A cataloguer working on a public numismatics collection can pick the capable cloud model; a researcher working on protected oral-history testimonies picks the local one — or, if they forget and pick the cloud model, the egress gate refuses the restricted records and tells them to switch. That combination — user choice plus a hard server-side backstop — is the whole design; see [Privacy & security](privacy_and_security.md).

---

## Vision (images)

A model marked `vision: true` can receive images. When the selected model is vision-capable, the chat footer shows an **attach** button; the user can attach an image file (JPEG, PNG, WebP, GIF) or the current record's image, and ask the assistant to describe or transcribe it. Attaching an image to a non-vision model is refused server-side, not silently dropped. Image size limits are in the [configuration reference](configuration.md#request-limits).

## Validation and fail-closed rules

The catalog is validated on **every request** (there is no cached, drifting copy). The rules are strict and fail-closed:

- Malformed JSON, or **any** invalid entry, disables the whole assistant — never a partial list. The server log names the offending entry (`DEDALO_AGENT_MODELS[2]: …`).
- Duplicate `id`s are rejected.
- An `anthropic` entry with `egress: "local"` is rejected.
- An `openai_compatible` entry missing `endpoint` or `egress` is rejected.
- An `api_key_env` that doesn't end in `_API_KEY` / `_KEY` / `_TOKEN` is rejected.

If the assistant is disabled and you expected it on, this validation is the first thing to check.
