# Model behaviour and disclosure

Helix serves a **local model** behind an **Anthropic-compatible** API. This
document records exactly what Helix promises, and what it deliberately does
not.

## The advertised model id is a routing alias

`helix-fable-5-2` is the name clients send. It selects a deployment in the
local model catalog. It is not a claim that Anthropic's Claude Fable 5.2 is
serving the request.

| Surface | What it says |
|---|---|
| `GET /v1/models` | `id`, `display_name`, `backend` (`local:llama3.2:3b`), and a `disclosure` sentence |
| Every response | `x-helix-upstream-provider`, `x-helix-upstream-model` |
| The MCP `instructions` field | "The tools here call the Higgsfield generation API; outputs are AI-generated and consume credits." |
| Every generation tool description | "The output is AI-generated and the call consumes credits." |
| Every generation result | `structuredContent.ai_generated = true`, plus the provider name and the provider's terms URL |

### Using the literal `claude-fable-5-2`

Setting `HELIX_ADVERTISE_MODEL_ID=claude-fable-5-2` makes Helix answer to
that id, which is useful when a client hardcodes it (Claude Code's
`/model claude-fable-5-2`, or a pinned `availableModels` list).

Anthropic's trademark guidelines say their marks may not be used in a way
that implies sponsorship, endorsement, or affiliation without express
authorisation. So:

- The literal id is intended for a **single-operator install** where the
  operator knows exactly what is behind it.
- The disclosure surfaces above are still populated. Nothing is hidden.
- For anything wider than one operator, keep the Helix-namespaced id.

## The Fable 5.2 request contract

Helix reproduces the request contract of `claude-fable-5-2` so that a client
written against it behaves identically.

| Request field | Behaviour |
|---|---|
| `output_config.effort` | `low`…`max`; default `high`. Mapped to the local model's `reasoning_effort` where supported (`xhigh`/`max` clamp to `high`) |
| `output_config.format` | `json_schema`; mapped to `response_format` where the upstream supports it, otherwise schema-injected and validated on the way out |
| `thinking` | `adaptive` accepted; `enabled`, `disabled` and `between_tools` rejected with the upstream's wording |
| `tool_choice` | `auto` and `none` accepted; `any` and `tool` rejected with the upstream's wording |
| `temperature`, `top_p`, `top_k` | Rejected. Under `anthropic-version: 2026-10-21` any value is rejected; under `2023-06-01` only non-default values are |
| `cache_control` | Accepted; used for prefix accounting. Helix does not write Anthropic caches |
| `max_tokens: 0` | A cache prewarm: an empty message is returned and the upstream is not called |
| `stop_sequences`, `metadata`, `speed`, `service_tier` | Accepted |

### Response shape

`usage.input_tokens` counts only tokens **after** the last cache breakpoint,
so total input is `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens` — the Anthropic convention, not the OpenAI one.

Streaming emits the Anthropic event vocabulary with named `event:` lines:
`message_start`, then `content_block_start` / `content_block_delta` /
`content_block_stop` per block, then `message_delta` (with cumulative usage),
then `message_stop`. `ping` and mid-stream `error` frames are supported.

### Thinking signatures

Fable 5.2 always emits a `thinking` block carrying an Anthropic signature.
Helix cannot produce a real one, so it mints its own:

- Format: `hx1.<base64url(HMAC-SHA256(signing_key, conversation_digest | index | thinking))>`.
- The digest covers the tools, the system prompt and the messages, so a
  thinking block moved into a different conversation fails verification.
- On the way back in, a block that fails verification is **dropped** and
  recorded, rather than rejected — a client may legitimately have edited its
  own history, and rejecting the whole request would be hostile.
- These are Helix HMACs. They are not Anthropic signatures and are not
  verifiable by Anthropic. The `hx1.` prefix makes that unmistakable.

`HELIX_SIGNING_SECRET` controls the key. Changing it invalidates every
outstanding thinking block, which is safe: they are simply dropped.

## Media generation

Generation runs against the Higgsfield API. Helix passes the upstream bytes
through **unmodified**: no transcoding, no re-muxing, no cropping, no
frame interpolation.

That matters because the provenance signals ride in the media:

- **SynthID** is pixel-level. Aggressive transcoding degrades it.
- **C2PA** is a metadata manifest. Any re-encode that does not carry the
  manifest through destroys it.

Higgsfield's terms forbid obscuring its provenance signals, and EU AI Act
Article 50(2) treats machine-readable marking as a duty. Byte-for-byte
pass-through is the only way to keep both.

Helix never claims an output is human-made, and never claims a model it did
not use.

## The "unlimited" question

Helix does not offer unlimited media generations, and the words "unlimited
generations" do not appear in the product.

What is actually unlimited is the **agent layer**: the local model runs on
your own hardware, so agent turns cost electricity rather than money. Media
generation spends real money at Higgsfield and is metered against a USD
budget, reserved at admission and settled on completion.

## Why Antigravity is not a backend

Not used in this build, for three reasons:

1. **Fable 5.2 is not in Antigravity.** Its picker offers Claude Opus/Sonnet
   5.5 and 4.6, plus GPT-OSS-120B and the Gemini models. No Fable, no Mythos.
2. **Antigravity's terms forbid it for a served product.** Clause 6: "using
   the Service in connection with products not provided by us… Using third
   party software, tools, or services to access the Service… is a breach."
   The FAQ repeats it for `agy -p` wrapping and account rotation. Enforcement
   is live — a `403 … TOS_VIOLATION` was reported in November 2026 for
   exactly this pattern.
3. **Google's API terms would then bind Helix**, and §4.a is the sharpest
   clause of the three labs: "Sublicense an API for use by a third party…
   you will not create an API Client that functions substantially the same as
   the APIs and offer it for use by third parties." Unlike Anthropic §D.4
   ("except as expressly approved") or OpenAI's Usage Policies ("prior review
   and approval"), Google states no approval path at all.

Antigravity remains usable **locally**, for a single operator, under the
terms that allow it. If it is ever added as a deployment, it must be a paid
Gemini Enterprise project, and the free tier must never back end-user traffic
— Gemini's "Unpaid Services" terms say human reviewers may read prompts and
outputs, and in the EEA/CH/UK you may not make API clients available to users
on unpaid services at all.

## If real Fable 5.2 is ever required

`claude-fable-5-2` is generally available on Google Cloud (Gemini Enterprise
Agent Platform) under the same model id, and on Anthropic's own API. Routing
to either needs no mimicry at all, and the model id becomes literally true.
