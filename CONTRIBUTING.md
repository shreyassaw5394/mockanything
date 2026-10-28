# Contributing

Thanks for helping. The most valuable contributions are packs for APIs people actually use, especially regional payment, messaging and identity providers.

## Pack rules

A pack is a YAML file in `packs/`. To keep the project clean for everyone:

1. **Facts only.** Endpoint paths, field names, ID formats, status values, error codes and the test values a provider documents. Do not paste documentation sentences, example payloads or guides. Write example values yourself.
2. **No branding.** No logos, icons, colours or fonts. Name the provider in plain text only, exactly as they write it.
3. **Say where the facts came from.** Set `source` (URL and licence of any API description you used). If the provider publishes its API description under an open licence, note it in `NOTICE`.
4. **Disclaimer.** Start the file with a comment saying the pack is not affiliated with or endorsed by the provider.
5. **Test it.** Add a test that drives the pack with the provider's official SDK where one exists (see `tests/packs.test.ts`), including at least one webhook signature check if the provider signs webhooks.
6. **Test values only.** Never add real card numbers, real phone numbers or real accounts.

Some providers ask that their names or materials are not used without permission. If a provider's terms say so, open an issue first; we'll ask them before adding a pack.

## Developing

```bash
npm install
npm run check     # typecheck, lint, tests, build
npx tsx src/cli/index.ts stripe
```

## Sign-off (DCO)

Every commit must be signed off to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "Add Acme Pay pack"
```

By contributing you agree your contribution is licensed under the Apache License 2.0.
