# Cogover Custom Backend Module Starter

[English](README.md) | [Tiếng Việt](README.vi.md)

A minimal TypeScript starter for developing, testing, and publishing a Cogover
Custom Backend Module. The same handler runs through the local HTTP runner and
on the Cogover Runtime Server.

## Requirements

- Node.js 20 or later.
- A Cogover Custom Backend Module Project with its Project ID and slug.
- The Workspace HTTPS origin, for example `https://example.cogover.com`.
- A Project key for local Development Sessions.
- A separate Workspace API key when publishing or activating with the CLI.

## Install

Install the Cogover Dev CLI and the project dependencies:

```bash
npm install --global @cogover/dev-cli
npm install
```

## Configure the Project

Create the local Project configuration:

```bash
cp cogover.example.json cogover.json
```

Replace the placeholders in `cogover.json`:

```json
{
  "version": 1,
  "runtimeUrl": "https://example.cogover.com",
  "projectId": "replace-with-project-id",
  "projectSlug": "replace_with_project_slug"
}
```

`runtimeUrl` must be the Workspace HTTPS origin without an additional path.
The local `cogover.json` file is intentionally ignored by Git.

## Add an Entry Point

Create `src/main.ts`. For example:

```typescript
import { createRouter } from "@cogover/sdk";

const router = createRouter();
router.get("/", async () => ({ ok: true }));

export default router.toHandler();
```

Keep deployable code in `src/`. Files under `local/` support local development
and must not be imported by code in `src/`.

## Develop Locally

Log in with the Project key using the hidden prompt, then validate the setup:

```bash
cogover-dev login --profile <project-slug>
cogover-dev doctor --profile <project-slug>
```

Start the local API through a Development Session:

```bash
COGOVER_LOCAL_PORT=3100 cogover-dev run --profile <project-slug> -- npm run dev
```

The local URL is:

```text
http://127.0.0.1:3100/api/v1/ts-projects/<project-slug>
```

Run the type checker independently with:

```bash
npm run typecheck
```

Run the tests of the local tooling with:

```bash
npm test
```

## Run Record Triggers Locally

Cogover sends real record events only to the active published version of a
Project. To debug a trigger before publishing it, declare it with
`defineTrigger`, list it in the named `triggers` export of `src/main.ts`, and
start the local server as above. The default export becomes optional when the
Project only has triggers. At startup the server prints the trigger keys, and
`GET /__cogover/triggers` lists them with their normalized configuration.

Run one trigger on demand with real records read through the Development
Session:

```bash
curl -s -X POST 'http://127.0.0.1:3100/__cogover/triggers/order_credit_check' \
  -H 'Content-Type: application/json' \
  --data '{"operation": "update", "recordId": "<record-id>", "changes": {"status": "confirmed"}}'
```

- `operation` is `create`, `update`, or `delete`.
- `update` and `delete` read record `recordId` of the trigger's Object, limited
  to the trigger's `fields`, into `record.old`. For `update`, `changes` is
  applied on top to form `record.new`; use the values as the handler should see
  them.
- `create` builds `record.new` from `changes` alone; the record has no `id` yet.
- Send `records: [{"recordId": "...", "changes": {...}}, ...]` instead of the
  single-record shorthand to run one call for up to 200 records.

The response contains `input.records` exactly as the handler received them,
`results` with the `changes` and `errors` of each record in the format the
handler returns to Cogover, and `warnings`. The runner does not evaluate `when`,
`changedFields`, or `runWhen`; it reports in `warnings` when Cogover would have
skipped the trigger. A field in `changes` that is not listed in `fields` is
ignored and reported.

Before-change handlers are read-only in Cogover, but a local Development Session
does not enforce that. Start `cogover-dev run --allow-writes=false` while testing
before-change triggers so that a write in the handler fails locally too. Routes
under `/__cogover/` exist only on the local server.

## Publish and Activate

`npm run build` performs a TypeScript preflight check; it does not create the
upload archive. Publish the `src/` directory and activate the ready version:

```bash
npm run build
cogover-dev publish
cogover-dev activate <version-id>
```

Publishing and activation require a Workspace API key. The Workspace API key
and Project key are different credentials and cannot replace one another.

## Security

Never put a Project key, Workspace API key, session cookie, token, or other
credential in source code, `cogover.json`, Git, or a command-line argument.
The CLI prompts for keys without echoing them. Keep `.env` and exported session
files untracked.

## Project Layout

```text
.
├── cogover.example.json
├── local/
│   ├── cli.ts
│   ├── local-server.ts
│   ├── trigger-runner.ts
│   └── trigger-runner.test.ts
├── src/
├── package.json
├── package-lock.json
└── tsconfig.json
```

## License

MIT
