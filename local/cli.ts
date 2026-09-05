import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import type {SandboxHandler} from "@cogover/sdk";
import {startLocalServer} from "./local-server.js";

const USAGE = `Usage:
  node --import tsx local/cli.ts --entry <project-entry>

Example:
  node --import tsx local/cli.ts --entry ./src/main.ts
`;

class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

function configuredPort(): number {
    const raw = process.env.COGOVER_LOCAL_PORT ?? process.env.PORT ?? "3000";
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new UsageError("COGOVER_LOCAL_PORT or PORT must be an integer from 1 to 65535.");
    }
    return port;
}

function configuredEntry(args: string[]): string | "help" {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return "help";
    if (args.length !== 2 || args[0] !== "--entry" || !args[1]) {
        throw new UsageError("A project entry point is required.");
    }
    return args[1];
}

async function loadProjectHandler(entry: string): Promise<SandboxHandler> {
    const module = await import(pathToFileURL(resolve(entry)).href) as {default?: unknown};
    if (typeof module.default !== "function") {
        throw new Error(`Project entry point must default-export a handler: ${entry}`);
    }
    return module.default as SandboxHandler;
}

async function serve(handler: SandboxHandler): Promise<number> {
    const local = await startLocalServer({handler, port: configuredPort()});
    process.stdout.write(`Cogover local project server listening at ${local.url}\n`);
    process.stdout.write("Caller identity: caller_personnel_id from the active Project key Development Session.\n");
    process.stdout.write("context.invocation: public user/workspace snapshot from the active Development Session.\n");
    await new Promise<void>(resolve => {
        const stop = (): void => {
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            void local.close().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
    return 0;
}

async function main(): Promise<number> {
    try {
        const entry = configuredEntry(process.argv.slice(2));
        if (entry === "help") {
            process.stdout.write(USAGE);
            return 0;
        }
        return await serve(await loadProjectHandler(entry));
    } catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(`${error.message}\n\n${USAGE}`);
            return 2;
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        process.stderr.write(`${JSON.stringify({ok: false, code: "UNEXPECTED_ERROR", message})}\n`);
        return 1;
    }
}

process.exitCode = await main();
