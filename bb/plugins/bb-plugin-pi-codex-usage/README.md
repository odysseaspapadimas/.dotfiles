# Pi Codex Usage

Local BB plugin. Shows compact used-percentage/reset text (e.g. **23%/5d10h**) beside the composer’s model selector only
when the selected BB provider is Pi and the selected model belongs to
`openai/` or `openai-codex/`.

Uses BB's existing `provider-codex` usage RPC on the thread/selected machine.
It does not read, copy, or refresh credentials itself. The Codex login may be a
different account from Pi, and its limits must not be interpreted as Pi's
OpenAI subscription-sharing allowance.

Account details, exact reset date and the Codex caveat live in the hover tooltip.
Uses a scope-local DOM portal from the supported composer action slot because BB
currently has no model-accessory slot. Falls back to the action row if no model
button is found; releases the portal and observer when unmounted.

Refreshes once per minute while visible, on focus, or by clicking the text. Explicit
refresh asks the provider for fresh data; automatic refresh permits its cache.
Unsupported new-machine selections hide the banner until a host is known.

```sh
npm install --ignore-scripts --include=dev
npm test
npm run typecheck
bb plugin build .
bb plugin install . --yes
```

Disable with `bb plugin disable pi-codex-usage`.
