# Third-party notices

UniQlaw is MIT-licensed (see [LICENSE](LICENSE)). The repository also contains these files derived from third-party projects:

| path | source | license |
|---|---|---|
| `packages/provider-codex/src/protocol/` | TypeScript types generated from the [OpenAI Codex CLI](https://github.com/openai/codex) app-server protocol (`codex app-server generate-ts`, codex-cli 0.166.0) | Apache-2.0 |
| `packages/platform-line/test/spec/messaging-api.yml` | LINE Messaging API OpenAPI document from [line/line-openapi](https://github.com/line/line-openapi), used only by tests | Apache-2.0 |

Runtime dependencies installed by `bun install` keep their own licenses; see each package under `node_modules/`.
