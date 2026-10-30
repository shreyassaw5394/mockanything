## 0.2.0

First public release.

- Twins of any API: built-in packs (Stripe, Paystack, Twilio, Resend, GitHub), any OpenAPI or Swagger spec, any API name in the public APIs.guru directory, and HAR recordings.
- `mockanything verify`: measures how closely a twin matches the real API's sandbox, using your own test key.
- `--persist` / `--state <file>`: keep a twin's data between restarts.
- MCP server for agents, local dashboard, signed webhooks, scenarios, chaos and a test clock.
