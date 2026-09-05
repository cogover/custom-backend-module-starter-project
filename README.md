# Cogover Custom Backend Module Starter

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
│   └── local-server.ts
├── src/
├── package.json
├── package-lock.json
└── tsconfig.json
```

## License

MIT
