# LINE spec sources

- `messaging-api.yml`, `webhook.yml`: official LINE OpenAPI specs,
  https://github.com/line/line-openapi at commit `967498a4e192` (2026-10-27),
  downloaded from `https://raw.githubusercontent.com/line/line-openapi/967498a4e192/<file>`.
- `openapi-to-ajv.ts` converts their `components.schemas` for strict ajv validation (discriminator dispatch,
  unknown-field rejection). Used by `test/conformance.test.ts`.
