# Pi session orchestrator

The `pi_sessions` tool discovers and manages local Pi sessions running in Herdr.

## Creating a session

`create` requires a name and a self-contained starting message. By default, the new session inherits the current Pi model and thinking level.

To select another model, pass its fully qualified `provider/model` name:

```json
{
  "action": "create",
  "name": "Luna worker",
  "message": "Reply hi",
  "model": "openai-codex/gpt-5.6-luna"
}
```

The override applies only to the created session and is preserved when that session is resumed. Malformed values (for example a model without its provider) are rejected before a session record or Herdr tab is created. Omitting `model` preserves the existing inheritance behavior.
