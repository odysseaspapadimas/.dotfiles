# Codex Fast Mode

A small Pi extension that enables OpenAI Codex Fast Mode by combining Pi's
native `serviceTier: "priority"` support with the Codex WebSocket originator
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

When Fast Mode is active for the selected model, a minimal accent-colored
`fast` marker is shown last on Pi's extension-status footer line.

## Supported models

Only ChatGPT-authenticated `openai-codex` requests are changed:

- `gpt-5.4`
- `gpt-5.5`
- `gpt-5.6-luna`
- `gpt-5.6-sol`
- `gpt-5.6-terra`

Codex Spark and mini models are deliberately left unchanged. The extension
does not affect the API-key-backed `openai` provider, avoiding accidental API
Priority Processing charges.

Fast Mode consumes ChatGPT Codex credits faster than standard mode. See
[OpenAI's speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed).
