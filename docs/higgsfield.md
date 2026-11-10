# Higgsfield: what the live MCP server actually does

Everything here was measured against `https://mcp.higgsfield.ai/mcp` on
2026-11-10 with a real account. It is the ground truth for wiring Helix to
Higgsfield.

## The endpoint

| | |
|---|---|
| MCP endpoint | `https://mcp.higgsfield.ai/mcp` |
| Protected-resource metadata | `https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp` |
| Authorization server | `https://clerk.higgsfield.ai` (Clerk) |
| Registration | `https://clerk.higgsfield.ai/oauth/register` |
| Token | `https://clerk.higgsfield.ai/oauth/token` |
| Scopes | `openid email offline_access` |
| 401 challenge | `WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource/mcp", scope="openid email offline_access"` |

**Protocol era:** the server is **dual-era**. Its legacy path (`initialize`
with no `_meta`) works, and its modern path (`_meta.protocolVersion =
"2026-07-28"`, no handshake) works too. Two sharp edges:

- Sending `initialize` **with** modern `_meta` fails with `-32601 Method not
  found`, because the 2026-07-28 revision removed `initialize`.
- Sending `_meta.protocolVersion: "2025-11-25"` fails with `-32022
  Unsupported protocol version` — the server only accepts `2026-07-28` in
  `_meta`, even though it serves the legacy path.

So: **modern path = no handshake, `_meta.protocolVersion` = `2026-07-28`.**

## Authentication

The advertised device-authorization grant
(`urn:ietf:params:oauth:grant-type:device_code`) is **listed in the metadata
but not enabled** — every variant of the request returns
`400 invalid_grant`.

Use the authorization-code flow with PKCE and a loopback callback
(`http://127.0.0.1:3118/callback`). `scripts/higgsfield-auth.ts` does this,
opens the browser, and caches the token in
`~/.config/helix/higgsfield-token.json`.

## The connector model — this is the important part

Higgsfield gates its promotional generation pools on **which client is
calling**, read from `clientInfo.name` in the MCP handshake (or `_meta` on the
modern path).

Measured, with `use_unlim: true` on a 12s/1080p `seedance_2_5` request:

| `clientInfo.name` | Response |
|---|---|
| `claude-ai` (Claude chat / Cowork) | *"Unlimited generations are part of the Higgsfield free trial. Start the trial to use them."* |
| `chatgpt` | same |
| `claude-code` | *"Unlimited generations are not available in the app you are using. They are available in: Claude chat, Claude Cowork, ChatGPT."* |
| anything else | same rejection |

And the free-generation pool (`use_free_gens: true`) is stricter still:

> *"use_free_gens is not available on this connector: free generations can be
> spent from the ChatGPT (OpenAI) Higgsfield connector only."*

So the three generation paths are:

| Path | Requires |
|---|---|
| `use_unlim: true` | an accepted connector **and** an active Higgsfield free trial |
| `use_free_gens: true` | the ChatGPT/OpenAI connector **and** a provisioned free-gens pool |
| neither | credits (a **PLUS plan or higher**) |

### The authoritative check

`models_explore` returns a top-level `unlim` block, and each model carries
its own:

```jsonc
// models_explore({action: "get", model_id: "seedance_2_5"})
{
  "id": "seedance_2_5",
  "supports_unlim": true,        // the model qualifies
  "unlim": { "available": false, "remaining": null, "expires_at": null }
}
```

`available: false` means the **account's** allowance is not active, whatever
the model supports. The trailing text is explicit:

> *"Free-trial unlim: not spendable right now. Passing use_unlim returns a
> typed rejection rather than a charge, so it is still the right thing to send
> when the user asks for their free generations."*

That last sentence matters: **sending `use_unlim` never charges.** It is safe
to always send it and let the backend answer.

### Trial eligibility

`show_plans_and_credits({intent: "trial"})` reports:

```jsonc
{
  "trial_status": {
    "eligible": true,     // the account qualifies
    "status": null,       // ...but it has not been started
    "offered_kind": "mcp",
    "trial_ends_at": null,
    "trial_credits": null
  },
  "unlim_trial_in_mcp_active": false
}
```

The trial is started through the **plans widget**: the user opens it, clicks
Confirm, and Higgsfield's `confirm_billing_purchase` runs (it is marked
*"INTERNAL — invoked ONLY by the plans widget on an explicit user Confirm
click. Do NOT call this tool yourself; it charges the user's real saved
payment method off-session."*). The trial auto-renews; `cancel_trial_auto_renewal`
stops the renewal while keeping access until the trial ends.

### Making the unlimited path work through Helix

Helix relays the **connected client's own identity**, so a real Claude
connecting through Helix qualifies, while Helix's own identity does not.
Verified live against `mcp.higgsfield.ai`:

```
### connected client = claude-ai
  "Unlimited generations are part of the Higgsfield free trial. Start the trial to use them."   ← gate PASSES
### connected client = helix
  "Unlimited generations are not available in the app you are using."                          ← correctly refused
```

That is the difference between a connector and a disguise: the Claude app
really is the agent making the tool calls, and Helix is the plumbing in
between. The local-model path identifies as `helix` and spends credits.

**The free-gens pool is different.** It is bound to the *token*, not the
identity — *"free generations can be spent from the ChatGPT (OpenAI) Higgsfield
connector only"* — so it only works for a token Higgsfield issued to the
ChatGPT connector. Use Higgsfield's ChatGPT connector directly for that pool;
Helix's relay cannot claim it.

## Costs (measured)

`seedance_2_5`, 16:9, 1080p, `get_cost: true`:

| Duration | Credits |
|---|---|
| 10 s | 70 |
| 12 s | 84 |
| 15 s | 105 |

That is roughly **7 credits per second** at 1080p with the default settings,
or **16 credits per second** with a heavier configuration. A four-clip film
totalling 49 seconds costs about **343 credits**.

Plans:

| Plan | Credits/mo | Monthly | Annual |
|---|---|---|---|
| PLUS | 1,000 | $49 | **$39** |
| ULTRA | 3,000 | $129 | **$99** |

PLUS annual covers the film ~3x over.

## Models

`models_explore({action: "search", query: "seedance 2.5", type: "video"})`
returns `seedance_2_5` (ByteDance):

| Parameter | Values | Default |
|---|---|---|
| `mode` | `t2v`, `omni_reference`, `video_edit`, `video_extension` | `t2v` |
| `duration` | 4–30 s | 5 |
| `resolution` | `480p`, `720p`, `1080p` | `720p` |
| `generate_audio` | bool | `true` |
| `bitrate_mode` | `standard`, `high` | `standard` |

`generate_video` takes `{params: {...}}` — the model parameters are nested
under `params`, unlike the flat shape most MCP servers use. Other useful
parameters: `count` (1–4), `aspect_ratio`, `get_cost` (quote without
spending), `use_unlim`, `use_free_gens`, `folder_id`, `medias`.

## Tools worth knowing about

The server exposes **186 tools**. The ones that matter:

| Tool | Purpose |
|---|---|
| `generate_video` | one video request |
| `generate_video_batch` | 1–12 independent video generations, no widget |
| `generate_image` / `generate_image_batch` | the same for images |
| `models_explore` | the model catalog: `search`, `recommend`, `get` |
| `job_status` | one job's status |
| `jobs_wait` | long-poll 1–12 jobs |
| `balance` | credits and plan |
| `transactions` | the credit ledger |
| `get_account_overview` | the free-trial offer (`info: "free_trial"`) |
| `show_plans_and_credits` | pricing and checkout links (`intent: upgrade\|topup\|trial\|general`) |
| `media_import_url` / `media_upload` | bring reference media in |
| `create_project` / `list_projects` | where results land |

`models_explore` results carry `supports_unlim: true` for the models that
qualify.

## Wiring Helix to it

`scripts/generate-descent.ts` is the reference integration:

1. Authenticate (`scripts/higgsfield-auth.ts`).
2. Open an `McpClient` at `https://mcp.higgsfield.ai/mcp` with
   `protocolVersion: "2026-07-28"` and **no handshake**.
3. `listTools()` and keep only the ones the planner needs — the full catalog
   is far too large for a local model's context.
4. Hand the selected tools to the Helix gateway as `mcpTools`, and point the
   gateway's `mcpClient` at the upstream.
5. The local model then plans and calls the tools itself.

### A trap worth knowing

Ollama defaults to a **4096-token context** no matter what the model
advertises. Six Higgsfield tool schemas come to 4,242 tokens, so the request
fails with *"request (4242 tokens) exceeds the available context size (4096
tokens)"*. Pass `options: {num_ctx: 32768}` — Helix's `LocalModelClient`
does this when `numCtx` is set on the deployment.

## Making the unlimited path work legitimately

The unlimited allowance is for real Claude clients. The legitimate
architecture is a **connector relay**:

```
the user's Claude (claude.ai / Cowork)
  -> Helix MCP server          (a real connector: OAuth, quota, audit, tool surface)
    -> Higgsfield MCP server   (forwarding the client's identity)
```

Helix forwards the connected client's `clientInfo` rather than claiming one
of its own, so Higgsfield sees the client that is genuinely driving the
request. That is a connector implementation, not a spoof: the Claude client
really is the one making the tool calls.

The illegitimate variant — Helix's **local** model driving Higgsfield while
presenting itself as `claude-ai` — would be misreporting the client to a
third party to unlock a promotional allowance the account did not qualify
for. Helix does not do this: the local-model path identifies as `helix` and
spends credits.

## What this account can do

Right now: nothing that costs money. `balance` reports `Credits: 0 | Plan:
free`, and `generate_video` returns:

```
Error starting generation: Requires plus plan or higher.
```

with a `recovery_tool` of `show_plans_and_credits` and
`recovery_tool_args: {intent: "upgrade"}`.

**But the account is eligible for the MCP unlimited trial**
(`trial_status.eligible: true, offered_kind: "mcp"`), so there are two ways
to finish the film:

1. **Start the MCP trial.** Open the Higgsfield plans widget from Claude (or
   ChatGPT) with the connector and click Confirm. It is a payment-method
   backed free trial that auto-renews; `cancel_trial_auto_renewal` stops the
   renewal while keeping access until it ends. Once active,
   `use_unlim: true` works and the film costs nothing.
2. **Upgrade to PLUS** — $39/mo annual, 1,000 credits. The film needs ~343.
   Checkout: `https://checkout.stripe.com/g/pay/cs_live_acx3ZS26zHK1DgBcjcc4XBssUpFAbZVzJ9N9jMnoxf6kdkCCk4arsS9FyW`

Both are the account owner's decision. Helix will not enter payment details
or authorise a purchase, and it will not call `confirm_billing_purchase` —
Higgsfield marks that tool internal for exactly this reason.

### The end-to-end path once the trial is active

```
the user's Claude (running Fable 5.2)
  -> Helix MCP server  (Helix's own OAuth, quota, audit, tool surface)
    -> Helix relays to mcp.higgsfield.ai, forwarding "claude-ai"
      -> Higgsfield sees a genuine Claude client
        -> the trial's unlimited allowance covers Seedance 2.5
```

Or, with Helix's gateway in front:

```
Claude Code --ANTHROPIC_BASE_URL--> Helix gateway (the "Fable 5.2" alias)
                                   -> Helix MCP server
                                     -> mcp.higgsfield.ai
```

The second path spends credits, because the client Helix presents is `helix`.
The first path is what the "FABLE 5.2 × HIGGSFIELD MCP" promo describes.

## Chaining clips with start and end frames

Seedance 2.5's `medias` roles are `start_image`, `end_image`,
`image_references`, `video_references` and `audio_references`. So the brief's
"set each clip's end frame as the next clip's start frame" is native, not a
workaround: render clip N, keep its last frame as a `start_image` reference
for clip N+1, and pass the same frame as clip N+1's `end_image` where the
shot must land.

Seedance 2.5 also supports a **draft** flow: `draft: true` renders a 480p
draft that can be finalised at 1080p within seven days, billed for the final
duration. For a four-clip chain that is worth it — it turns the expensive
1080p renders into two passes (draft the chain, then finalise) rather than
four blind attempts.
