## 0.2.0

First public release.

- Twins of any API: built-in packs (Stripe, Paystack, Twilio, Resend, GitHub), any OpenAPI or Swagger spec, any API name in the public APIs.guru directory, and HAR recordings.
- `mockanything verify`: measures how closely a twin matches the real API's sandbox, using your own test key.
- `--persist` / `--state <file>`: keep a twin's data between restarts.
- OpenAI pack: chat completions with canned `[mock]` replies, forced tool calls and errors, the Responses API, embeddings, models.
- 54 popular APIs load from the provider's own current spec (`mockanything list`).
- Read-only APIs return sample objects instead of empty results.
- Works as a plain skill: `events`, `state`, `scenario`, `chaos`, `clock`, `reset`, `running`, `docs` and `guide` commands drive a twin from the shell.
- Measured: all 2,528 APIs in the public directory start a twin; 37,770 calls, no server errors.
- MCP server for agents, local dashboard, signed webhooks, scenarios, chaos and a test clock.
