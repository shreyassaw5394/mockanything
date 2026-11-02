## 0.2.2

- Spec twins: a POST whose only path is `/x/{param}` (for example Vonage `POST /sms/{format}`) now sends instead of answering 404.
- README: community link.

## 0.2.1

- Published as `@shipatmidnight/mockanything` (the command stays `mockanything`), with its listing in the MCP Registry.
- The site moved to [shipatmidnight.dev/mockanything](https://shipatmidnight.dev/mockanything).

## 0.2.0

First public release.

- Twins of any API: built-in packs (Stripe, Paystack, Twilio, Resend, GitHub), any OpenAPI or Swagger spec, any API name in the public APIs.guru directory, and HAR recordings.
- `mockanything verify`: measures how closely a twin matches the real API's sandbox, using your own test key.
- `--persist` / `--state <file>`: keep a twin's data between restarts.
- OpenAI pack: chat completions and the Responses API (streamed or not) with canned `[mock]` replies, forced tool calls and errors; embeddings; models.
- Anthropic pack: Messages (streamed or not) with canned `[mock]` replies, forced tool use and errors; token counting; models.
- Streaming responses (server-sent events) for any twin definition.
- 54 popular APIs load from the provider's own current spec (`mockanything list`).
- Read-only APIs return sample objects instead of empty results.
- Works as a plain skill: `events`, `state`, `scenario`, `chaos`, `clock`, `reset`, `running`, `docs` and `guide` commands drive a twin from the shell.
- Measured: all 2,528 APIs in the public directory start a twin; 37,770 calls, no server errors.
- MCP server for agents, local dashboard, signed webhooks, scenarios, chaos and a test clock.
