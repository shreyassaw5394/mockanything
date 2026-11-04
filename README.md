# Mock Anything

<!-- mcp-name: io.github.shreyassaw5394/mockanything -->

**A working twin of an API, running on your machine in one command. No keys, no sandbox sign-up, no bill.**

```bash
npx @shipatmidnight/mockanything stripe
# → Stripe twin running at http://localhost:4010/v1
```

Point your app or agent at that URL instead of the real one and it behaves like the real API for the flows it covers: create a customer, charge a test card, get the signed webhook, refund it. None of it is real, and your app's calls never reach the real provider.

Mock Anything works with most public APIs, not just a fixed list (every API in the public APIs.guru directory started as a twin in our [2026-10-29 measurement](#how-many-apis-work)):

```bash
npx @shipatmidnight/mockanything stripe                          # a hand-tuned pack
npx @shipatmidnight/mockanything ./openapi.yaml                  # your own OpenAPI / Swagger file
npx @shipatmidnight/mockanything https://example.com/openapi.json
npx @shipatmidnight/mockanything slack                           # any name in the public APIs.guru directory (2,500+ APIs)
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
| `openai` | Chat completions and the Responses API, streamed or not; embeddings; models. Replies are canned and start with `[mock]`; no model runs | Scenarios `tool_call`, `rate_limit`, `insufficient_quota`, `context_length_exceeded`, `server_error` |
| `anthropic` | Messages, streamed or not, with tool use; token counting; models. Replies are canned and start with `[mock]`; no model runs | Scenarios `tool_use`, `rate_limit`, `overloaded`, `invalid_request`, `api_error` |

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
- paths the spec doesn't describe still work as generic REST (marked with `x-mockanything-fallback`);
- read-only resources (nothing in the API creates them) return made-up sample objects shaped by the spec, so lookups and lists aren't empty.

See what was inferred, and change it:

```bash
npx @shipatmidnight/mockanything inspect ./openapi.yaml --out twin.yaml   # edit twin.yaml
npx @shipatmidnight/mockanything twin.yaml
```

### How many APIs work?

Measured on 2026-10-29 with `scripts/coverage.ts`, which builds a twin from each spec, creates objects, then calls every operation (up to 40 per API):

| Source | APIs | Twin starts | Calls without a server error | Calls that succeed |
|---|---|---|---|---|
| Every API in the public APIs.guru directory | 2,528 | 2,528 | 37,770 of 37,770 | 90.2% |
| Providers' own current specs (`mockanything list`) | 54 | 54 | 1,988 of 1,988 | 96.8% |

The calls that don't succeed get proper errors, mostly "not found" for an id that was never created, or a missing parent object. Starting and answering is not the same as matching the real API; `verify` measures that.

Popular APIs whose providers publish a current spec (Square, PayPal, Adyen, Discord, Jira, Cloudflare, Vercel, Supabase, Clerk, Hugging Face and more) are fetched from the provider's own published source rather than the directory, which is often out of date. Run `mockanything list` for all of them.

Twins built straight from the public Stripe, Twilio, GitHub and Resend specs, with no hand-tuning, pass the official SDKs' basic create/read/update/list/delete flows (`scripts/conformance.ts`).

### From a recording

Record your app talking to the real API (browser DevTools → Network → "Save all as HAR", or any proxy that writes HAR) and start a twin from the file:

```bash
npx @shipatmidnight/mockanything ./checkout.har
```

Mock Anything rebuilds the endpoints, id formats, list shapes and status lifecycles it saw. It keeps field names, types, id formats and short status/type codes only: ids are replaced with made-up ones of the same format, and header values, cookies, query values, free text, numbers and booleans from the recording are never copied into the twin. Emails, URLs and dates are replaced with made-up values.

No spec at all? Let your agent build one: the MCP tool `twin_from_docs` reads a documentation page and gives the agent a short format guide; the agent writes a twin definition and starts it with `twin_start`.

## For agents

### As a skill (no setup beyond the file)

Copy [`skills/mock-anything`](skills/mock-anything/SKILL.md) into `~/.claude/skills/` (or your agent's skills folder). Then tell the agent "mock Stripe", "test this against a fake Notion", or point it at a spec, a HAR file or a docs page. The skill uses only the command line: it starts a twin, points your app at it, and drives it:

```bash
npx @shipatmidnight/mockanything events                  # requests and webhooks the twin saw
npx @shipatmidnight/mockanything state                   # objects it holds
npx @shipatmidnight/mockanything scenario card_declined  # force an edge case on the next call
npx @shipatmidnight/mockanything chaos 5xx,429           # failures (chaos off to stop)
npx @shipatmidnight/mockanything clock 3d                # move time forward
npx @shipatmidnight/mockanything reset
```

For an API with only a docs page, `npx @shipatmidnight/mockanything docs <url>` gives the agent the page text and the twin format; the agent writes `twin.json`, checks it with `npx @shipatmidnight/mockanything validate twin.json`, and starts it.

### MCP

```bash
claude mcp add mockanything -- npx -y @shipatmidnight/mockanything mcp
```

Cursor, Windsurf and other MCP clients:

```json
{ "mcpServers": { "mockanything": { "command": "npx", "args": ["-y", "@shipatmidnight/mockanything", "mcp"] } } }
```

Tools: `twin_start`, `twin_from_docs`, `twin_env`, `twin_events`, `twin_state`, `twin_scenario`, `twin_chaos`, `twin_webhook_add`, `twin_emit`, `twin_advance_clock`, `twin_reset`, `twin_stop`, `twin_list`, `packs_list`.

`twin_start` loads files only if they are `.json`, `.yaml`, `.yml` or `.har`, inside the MCP server's working directory and not hidden. URLs on your own machine are off for agents unless you set `MOCKANYTHING_ALLOW_LOCAL=1` in the server's environment.

An agent can say "start a Stripe twin, build the checkout, then force a declined card and check my code handles it" without asking you for keys.

## Keep data between restarts

```bash
npx @shipatmidnight/mockanything stripe --persist            # ~/.mockanything/state/stripe.json
npx @shipatmidnight/mockanything stripe --state ./twin.json  # or a file you choose
```

Objects, id counters, the test clock, the webhook secret and registered webhook endpoints are saved shortly after each change and when the twin stops. The file is readable by you only. Delete it (or press Reset in the dashboard) to start fresh. Agents get the same with `twin_start` and `persist: true`.

## Dashboard

Every twin has a local dashboard (the link with its access token is printed at start): live requests and responses, webhooks sent and their delivery status, the twin's stored state, scenarios to force, and chaos controls.

## Command line

```
mockanything <api>                 start a twin (pack, API name, OpenAPI file or URL)
mockanything list                  built-in packs
mockanything inspect <api>         print the inferred definition (--out file.yaml)
mockanything validate <file>       check a twin definition
mockanything env <api>             config snippets
mockanything verify <api>          how closely the twin matches the real API (your test key)
mockanything running | events | state | scenario [name] | chaos <modes|off> | clock <duration> | reset
mockanything docs <url> | guide    build a twin from a docs page
mockanything mcp                   MCP server over stdio

--port <n>  --webhook <url>  --allow-webhook-host <host>  --cors <origin>
--chaos[=timeout,5xx,slow,429,dup-webhooks,out-of-order]  --chaos-rate <0..1>  --seed <n>
--persist  --state <file>  --overrides <file>  --json
```

## Safe by default

- Listens on `localhost` only. Delivers webhooks to `localhost` only unless you allow a host.
- Refuses live keys (`sk_live_…` and similar) and real-looking card numbers. Use the provider's documented test values.
- Test checkout pages are plain, carry a "not a real payment" banner, and only exist on your machine.
- No telemetry. The only outbound traffic is what you ask for: webhooks to the URLs you configure, downloads of the API descriptions you name (from the URL you give, the provider's published source or the APIs.guru directory), `verify` calls to the provider's sandbox with your test key, and npm when you install or run it with `npx`.

## How faithful is a twin?

A twin is only as good as the facts it was built from. Packs cover the main flow of each API, not every endpoint, and inferred twins make guesses that you can inspect and override.

`verify` measures it. It runs the same scripted calls against the twin and against the provider's real sandbox, using your own test-mode key, and compares status codes, field names, field types, id formats and error codes:

```bash
npx @shipatmidnight/mockanything verify stripe --key sk_test_...      # or set MOCKANYTHING_SANDBOX_KEY
npx @shipatmidnight/mockanything verify paystack --key sk_test_... --out report.md
npx @shipatmidnight/mockanything verify ./openapi.yaml --against https://api.example.com --key ...   # read-only list calls
```

```
  ✓ Create a customer                              200 / 200  <score>
  ✓ Declined card (error)                          402 / 402  <score>
  ...
  Fidelity <score>  status · fields · types · ids and codes
```

It only runs with test-mode keys (live keys are refused), asks before sending your key to a host that isn't one of the providers' own API hosts used by the built-in suites (`--yes` to skip), makes about one call a second with a hard cap per run, and creates a few test objects in your sandbox (the Stripe suite deletes its customer afterwards). The report lists field paths, types and code values only, never response data or your key. Built-in suites: `stripe`, `paystack`; write your own for any twin (see `packs/verify/`). Webhooks are not compared yet.

`mockanything list` shows each pack's published score and the date it was measured. Use twins to build and test quickly; run your final checks against the provider's sandbox before you ship.

## Twin definitions

Every twin, built-in or inferred, is a plain YAML/JSON definition run by one engine. Definitions are data: they cannot run code. See [`packs/`](packs/) for examples and `src/mcp/guide.ts` for the format.

## Contributing

Packs for more APIs are very welcome, especially regional ones. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: packs contain facts only (paths, fields, error codes, documented test values), never copied documentation text or logos.

## Community

Questions, ideas and show-and-tell: the [Ship at Midnight Discord](https://discord.gg/s8wj7tBAM), one server for every tool, with a channel for Mock Anything.

## Licence and notices

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Mock Anything is a free, non-commercial passion project by an independent developer. It is not affiliated with, endorsed by, or sponsored by any company whose API it simulates. Stripe, Paystack, Twilio, Resend, GitHub, OpenAI, Anthropic, Claude and other names are trademarks of their respective owners and are used only to describe compatibility.
