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

Besides the default export (HTTP routes), `src/main.ts` can list record triggers
in a named `triggers` export and Custom Module Actions in a named `actions`
export. The default export is optional when the Project has triggers or
actions.

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
start the local server as above. At startup the server prints the trigger keys, and
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
- A lookup value that the runner reads from the stored record has `name: ""`,
  because the read does not look up linked records; in Cogover, lookups in
  `record.old` and `record.new` carry the name. To test code that uses the name,
  put the lookup in `changes` as `{"id": "...", "name": "..."}`.
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

## Expose Actions to Processes and AI Agents

A Custom Module Action is a short operation of the Project that a Cogover
Process or AI Agent calls. Declare it with `defineAction` from `@cogover/sdk`
0.15.0 or later, describe its input and output with the `s` schema builder, and
list it in the named `actions` export of `src/main.ts`:

```typescript
import { defineAction, s } from "@cogover/sdk";

export const actions = [
  defineAction({
    key: "check_credit",
    label: "Check customer credit",
    description: "Returns whether an account can buy the given amount on credit.",
    exposeTo: ["process", "agent"],
    effect: "read",
    input: s.object({
      accountId: s.recordId("account").describe("ID of the customer account"),
      amount: s.number({ minimum: 0 }).describe("Order amount"),
    }),
    output: s.object({
      allowed: s.boolean(),
      reason: s.enum(["ok", "limit_exceeded", "account_not_found"]),
    }),
    async handler({ data }, input) {
      const account = await data.object("account").records.get(input.accountId, {
        fields: ["credit_limit", "credit_used"],
      });
      if (!account) return { allowed: false, reason: "account_not_found" };
      const remaining = Number(account.fields.credit_limit ?? 0) - Number(account.fields.credit_used ?? 0);
      const allowed = input.amount <= remaining;
      return { allowed, reason: allowed ? "ok" : "limit_exceeded" };
    },
  }),
];
```

- After you publish and activate the version, Process Builder offers each
  action exposed to `"process"` as a **Custom Module Action** node, and AI Agent
  Builder offers each action exposed to `"agent"` as a tool of the
  **Custom Module** category. They call the active version by Project slug and
  action `key`, so keep `key` stable between versions.
- An action for AI Agents needs a `description`; the agent also reads the
  `describe` texts of the input to fill it in.
- `effect: "read"` runs the action read-only in Cogover. A `"write"` action may
  change data, and an AI Agent tool for it asks a person for approval by default.
- Cogover checks the input before the handler runs and the output after it
  returns. A caller receives only the code and a fixed message of an error the
  handler throws, so report expected outcomes in the output, like `reason` above.
- The Process node or the AI Agent decides who the action runs as. A call
  without a user needs `allowInternalSystem: true` in the approved identity
  policy of the active version.
- An action has the budgets of an HTTP route and runs for at most `timeoutMs`
  milliseconds (1000 to 8000, 8000 by default). Hand longer work to a background
  job with `jobs.enqueue`, using `action.runId` as the idempotency key.

The option tables, schema rules and error codes are in the Custom Module Action
reference of the SDK,
`node_modules/@cogover/sdk/docs/en/api-reference/actions.md`, and
`processes.start` and `agents.start` in
`node_modules/@cogover/sdk/docs/en/api-reference/processes-and-agents.md`.

## Run Actions Locally

Processes and AI Agents only call the active published version. To debug an
action before publishing it, start the local server as above. At startup the
server prints the action keys, and `GET /__cogover/actions` lists them with
their normalized configuration, including the input and output JSON Schemas.

Call one action the way a Process node or an AI Agent does:

```bash
curl -s -X POST 'http://127.0.0.1:3100/__cogover/actions/check_credit' \
  -H 'Content-Type: application/json' \
  --data '{"input": {"accountId": "<record-id>", "amount": 1200}}'
```

- `input` is required: the action input as the caller sends it.
- `source` is optional: `{"type": "process"}` or `{"type": "agent"}`, with any of
  the fields of `invocation.source` (for example `"runAs": "PERSONNEL"` or
  `"interactive": true`). Missing fields get local placeholder values; an agent
  source's `initiatorPersonnelId` defaults to the Development Session caller.
  Without `source`, the runner uses the first entry of `exposeTo`. A type the
  action is not exposed to is refused with HTTP 403 `ACTION_NOT_EXPOSED`.
- `runId` is optional; a new one is generated otherwise. Send the same value
  again to test code that uses `action.runId` as an idempotency key.

The response has HTTP status 200 whenever the action ran, even when it failed.
It contains `status` (`COMPLETED` or `FAILED`), `output`, and `error` with the
`code`, `message`, and `details` that the Process node or AI Agent would
receive, plus `input` exactly as the handler received it, `action` (`key`,
`effect`, `runId`, `source`), `durationMs`, and `warnings`. An unknown action
key answers 404 and an invalid request body 400.

Like Cogover, the runner checks the input against the `input` schema before the
handler runs (`INPUT_INVALID`, the handler does not run) and the output against
the `output` schema after it returns (`OUTPUT_INVALID`), stops waiting after
`timeoutMs` (`TIMEOUT`), and reports an error the handler throws with the code
and fixed message a caller receives: `SCRIPT_ERROR` with
`details.scriptErrorCode`, `PERMISSION_DENIED`, or `RATE_LIMITED`. The terminal
of the local server shows the stack of an unexpected error. `cogover-dev run`
applies the budgets of an HTTP route to each call.

The local call differs from Cogover in these ways:

- It always runs as the Development Session caller, whatever `runAs` or agent
  identity Cogover would use; the runner adds a warning for `runAs: "SYSTEM"`.
- Cogover refuses writes and other side effects in a `"read"` action; a local
  Development Session does not. Start `cogover-dev run --allow-writes=false`
  while testing a read action so that a write fails locally too.
- Cogover returns the stored result when a caller repeats a finished `runId`,
  refuses a `runId` reused with another input, and stops loops with
  `MAX_HOP_EXCEEDED`; the local runner does none of this.
- After a `TIMEOUT` the handler may still be running locally; Cogover stops it.
- `processes.start` and `agents.start` start real runs from a writable
  Development Session, but a start that passes `onComplete` or `onResult` is
  refused with `NOT_SUPPORTED`: those jobs run only in a published version, so
  test them after publishing.

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
│   ├── action-runner.ts
│   ├── action-runner.test.ts
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
