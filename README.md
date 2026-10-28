# Mock Anything

**A working twin of any API, running on your machine in one command. No keys, no sandbox sign-up, no bill.**

```bash
npx mockanything stripe
# → Stripe twin running at http://localhost:4010/v1
```

Point your app or agent at that URL instead of the real one and it behaves like the real API for the flows it covers: create a customer, charge a test card, get the signed webhook, refund it. None of it is real, and nothing leaves your machine.

Mock Anything works with **any** API, not just a fixed list:

```bash
npx mockanything stripe                          # a hand-tuned pack
npx mockanything ./openapi.yaml                  # your own OpenAPI / Swagger file
npx mockanything https://example.com/openapi.json
npx mockanything slack                           # any name in the public APIs.guru directory (2,500+ APIs)
```

## Why

Agents write code that calls payments, SMS, email and developer APIs all day. Testing that today means real keys (the agent can spend money or text real people), sandboxes (accounts and keys for every provider, and many regional providers barely have one), or hand-written mocks that break the moment the agent does something you didn't expect.

A twin is different from a mock:

- **It keeps state.** POST a customer, then GET it back. Refund a payment and the remaining balance changes. Delete something and it's gone.
- **It behaves like the provider.** Real ID formats, list pagination, error shapes, status lifecycles (`requires_payment_method → succeeded`, `queued → sent → delivered`).
- **It sends webhooks**, signed the way the provider signs them, so your verification code runs unchanged.
- **It does the awkward parts:** declined cards, 3-D Secure, bounced emails, undeliverable SMS, duplicate references, rate limits.
- **Chaos mode** (`--chaos`) adds timeouts, 5xx errors, 429s, slow responses, duplicate and out-of-order webhooks. Seeded, so a failure you hit can be replayed.

## Built-in packs

Hand-tuned twins, checked against each provider's official SDK in our test suite.

| Pack | Flows | Test values |
|---|---|---|
| `stripe` | Customers, PaymentIntents (confirm, manual capture, cancel), refunds, Checkout Sessions, webhook endpoints, events | `pm_card_visa`, `pm_card_chargeDeclined`, `pm_card_chargeDeclinedInsufficientFunds`, `pm_card_threeDSecure2Required` … |
| `paystack` | Initialize → test checkout page → verify, charge saved cards, customers, refunds | Approve/Decline on the local test page |
| `twilio` | Send SMS, status callbacks (queued → sent → delivered), fetch, list, delete | `+15005550001` (invalid), `+15005550002` (unroutable), `+15005550004` (unsubscribed) … |
| `resend` | Send, retrieve, list, schedule, cancel; delivery, bounce and complaint events | `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev` |
| `github` | Repos, issues (open, edit, close, reopen), comments, pull requests (open, merge) | Any owner/repo works and starts empty |

`mockanything env <pack>` prints the snippet for pointing the official SDK at the twin, for example:

```js
const stripe = new Stripe("sk_test_mockanything", { host: "localhost", port: 4010, protocol: "http" });
```

## Any other API

Give Mock Anything an OpenAPI 3.x or Swagger 2.0 description (a file, a URL, or just the API's name) and it builds a stateful twin by reading the spec:

- `/things` + `/things/{id}` become a collection you can create, list, read, update and delete;
- `/things/{id}/cancel`-style paths become state changes, matched to the object's `status` values;
- nested paths are scoped (issues in one repo don't show up in another);
- response envelopes, pagination style, error shape, auth and OAS 3.1 webhooks are read from the spec;
- paths the spec doesn't describe still work as generic REST (marked with `x-mockanything-fallback`).

See what was inferred, and change it:

```bash
npx mockanything inspect ./openapi.yaml --out twin.yaml   # edit twin.yaml
npx mockanything twin.yaml
```

Twins built straight from the public Stripe, Twilio, GitHub and Resend specs, with no hand-tuning, pass the official SDKs' basic create/read/update/list/delete flows (`scripts/conformance.ts`).

No spec at all? Let your agent build one: the MCP tool `twin_from_docs` reads a documentation page and gives the agent a short format guide; the agent writes a twin definition and starts it with `twin_start`.

## For agents (MCP)

```bash
claude mcp add mockanything -- npx -y mockanything mcp
```

Cursor, Windsurf and other MCP clients:

```json
{ "mcpServers": { "mockanything": { "command": "npx", "args": ["-y", "mockanything", "mcp"] } } }
```

Tools: `twin_start`, `twin_from_docs`, `twin_env`, `twin_events`, `twin_state`, `twin_scenario`, `twin_chaos`, `twin_webhook_add`, `twin_emit`, `twin_advance_clock`, `twin_reset`, `twin_stop`, `twin_list`, `packs_list`.

An agent can say "start a Stripe twin, build the checkout, then force a declined card and check my code handles it" without asking you for keys.

## Dashboard

Every twin has a local dashboard (the link with its access token is printed at start): live requests and responses, webhooks sent and their delivery status, the twin's stored state, scenarios to force, and chaos controls.

## Command line

```
mockanything <api>                 start a twin (pack, API name, OpenAPI file or URL)
mockanything list                  built-in packs
mockanything inspect <api>         print the inferred definition (--out file.yaml)
mockanything validate <file>       check a twin definition
mockanything env <api>             config snippets
mockanything mcp                   MCP server over stdio

--port <n>  --webhook <url>  --allow-webhook-host <host>  --cors <origin>
--chaos[=timeout,5xx,slow,429,dup-webhooks,out-of-order]  --chaos-rate <0..1>  --seed <n>
--overrides <file>  --json
```

## Safe by default

- Listens on `localhost` only. Delivers webhooks to `localhost` only unless you allow a host.
- Refuses live keys (`sk_live_…` and similar) and real-looking card numbers. Use the provider's documented test values.
- Test checkout pages are plain, carry a "not a real payment" banner, and only exist on your machine.
- No telemetry. Nothing is sent anywhere except the webhooks you configure.

## How faithful is a twin?

A twin is only as good as the facts it was built from. Packs cover the main flow of each API, not every endpoint, and inferred twins make guesses that you can inspect and override. Use twins to build and test quickly; run your final checks against the provider's real sandbox before you ship. A fidelity report (`mockanything verify`, comparing a twin with the real sandbox) is next on the roadmap.

## Twin definitions

Every twin, built-in or inferred, is a plain YAML/JSON definition run by one engine. Definitions are data: they cannot run code. See [`packs/`](packs/) for examples and `src/mcp/guide.ts` for the format.

## Contributing

Packs for more APIs are very welcome, especially regional ones. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: packs contain facts only (paths, fields, error codes, documented test values), never copied documentation text or logos.

## Licence and notices

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Mock Anything is a free, non-commercial passion project by an independent developer. It is not affiliated with, endorsed by, or sponsored by any company whose API it simulates. Stripe, Paystack, Twilio, Resend, GitHub and other names are trademarks of their respective owners and are used only to describe compatibility.
