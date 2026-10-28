# OpenAI Fast Mode

A small Pi extension that enables Fast Mode on Pi's native `openai` and
`openai-codex` providers with a `before_provider_request` hook that adds
`service_tier: "priority"` (the compatible wire value; some endpoints reject
`"fast"`). For Codex only, it also sets the WebSocket originator
identifier (`originator: "codex_cli_rs"`) required by the ChatGPT OAuth backend.

## Usage

```text
/fast          toggle Fast Mode
/fast on       enable Fast Mode
/fast off      disable Fast Mode
/fast status   show its state and model compatibility
```

Fast Mode defaults to off. Its state is stored in the current session branch,
so it survives reloads and resumes while remaining branch-aware.

To enable it from the first request in a session created with `pi_sessions`,
pass `"fast": true` to `action: "create"`. Omit `fast` or pass `false` to keep it
off; the parent session's Fast Mode state is not inherited.

When Fast Mode is active for the selected model, an accent-colored `fast`
marker appears immediately left of the session lifetime in the rich footer.
Space is reserved so other extension statuses cannot truncate it; Pi's default
footer shows it first. When enabled on an unsupported model or provider, the
footer shows a dim `fast (inactive)` instead. Turning Fast Mode off removes
the marker.

## Supported models

The following models are supported on `openai` (Responses or Chat Completions)
and ChatGPT-authenticated `openai-codex`:

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-6-astra`
- `gpt-6-luna`
- `gpt-6-sol`
- `gpt-6.1-sol`

Codex Spark, mini models, and unrelated providers are deliberately left unchanged.

## Billing

Fast Mode is an explicit opt-in through `/fast on` (or `/fast` to toggle):

- On `openai`, Fast Mode incurs premium API token rates. See [OpenAI's API Fast Mode documentation](https://developers.openai.com/api/docs/guides/fast-mode).
- On `openai-codex`, Fast Mode consumes subscription usage or credits faster
  than standard mode. See [OpenAI's Codex speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed).

The footer reflects the requested mode, not a guarantee of the tier served;
the API may downgrade requests to standard processing.
