import assert from "node:assert/strict";
import test, {describe} from "node:test";
import {
    defineAction,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    s,
    ValidationError,
    type ActionContext,
    type ActionDefinition,
    type InvocationContext,
} from "@cogover/sdk";
import {
    loadActionDefinitions,
    MAX_ACTIONS_PER_PROJECT,
    parseActionRunRequest,
    runActionLocally,
    validateActionValue,
    ActionRunError,
    type ActionCallError,
    type ActionRunRequest,
} from "./action-runner.js";
import {startLocalServer, type LocalServerOptions} from "./local-server.js";

const invocation: InvocationContext = Object.freeze({
    identity: "user",
    workspace: {id: "WS1", name: "Test Workspace"},
    user: {accountId: "AC1", membership: {personnelId: "PER1", isSuperAdmin: false, roles: []}},
});

const scoreInput = s.object({
    leadId: s.recordId("lead").describe("ID of the lead to score"),
    rating: s.integer({minimum: 0, maximum: 10}),
    strict: s.boolean().optional(),
});
const scoreOutput = s.object({
    score: s.number(),
    tier: s.enum(["A", "B", "C"]),
});

interface SeenCall {
    input: unknown;
    context: ActionContext;
}

function scoreLead(seen: SeenCall[] = []): ActionDefinition {
    return defineAction({
        key: "score_lead",
        label: "Score lead",
        description: "Scores a lead and returns a tier.",
        exposeTo: ["process", "agent"],
        effect: "read",
        input: scoreInput,
        output: scoreOutput,
        handler(context, input) {
            seen.push({input, context: context as unknown as ActionContext});
            const score = input.rating * (input.strict ? 8 : 10);
            return {score, tier: score >= 80 ? "A" : score >= 50 ? "B" : "C"};
        },
    });
}

/** An action whose handler is replaced by `run`; the output schema accepts `{ok: boolean}`. */
function customAction(
    run: () => unknown,
    overrides: {key?: string; exposeTo?: readonly ("process" | "agent")[]; timeoutMs?: number} = {},
): ActionDefinition {
    return defineAction({
        key: overrides.key ?? "custom_action",
        label: "Custom action",
        description: "Runs a test handler.",
        exposeTo: overrides.exposeTo ?? ["process"],
        effect: "write",
        input: s.object({}),
        output: s.object({ok: s.boolean()}),
        ...(overrides.timeoutMs === undefined ? {} : {timeoutMs: overrides.timeoutMs}),
        handler: async () => run() as {ok: boolean},
    });
}

const describeAs = (error: unknown): ActionCallError => ({
    code: "SCRIPT_ERROR",
    message: "The action handler failed",
    details: {thrown: error instanceof Error ? error.message : String(error)},
});

function run(definition: ActionDefinition, body: Record<string, unknown>) {
    return runActionLocally({
        definition,
        request: parseActionRunRequest(body),
        projectSlug: "sales",
        invocation,
        describeHandlerError: describeAs,
    });
}

function isRunError(status: number, code: string, pattern: RegExp) {
    return (error: unknown): boolean => {
        assert.ok(error instanceof ActionRunError, `expected ActionRunError, got ${String(error)}`);
        assert.equal(error.httpStatus, status);
        assert.equal(error.code, code);
        assert.match(error.message, pattern);
        return true;
    };
}

describe("validateActionValue", () => {
    const schema = s.object({
        name: s.string({minLength: 2, maxLength: 5}),
        code: s.string().optional(),
        day: s.date().optional(),
        at: s.dateTime().optional(),
        count: s.integer({minimum: 1}).optional(),
        ratio: s.number({maximum: 1.5}).optional(),
        tags: s.array(s.string(), {maxItems: 2}).optional(),
        lines: s.array(s.object({qty: s.integer()})).optional(),
        owner: s.recordId("personnel").optional(),
    }).toJSON();

    test("returns the value with null optional properties removed", () => {
        const result = validateActionValue(schema, {name: "Anh", code: null, tags: ["a"], lines: [{qty: 2}]});
        assert.deepEqual(result, {value: {name: "Anh", tags: ["a"], lines: [{qty: 2}]}, issues: [], issueCount: 0});
    });

    test("reports each problem with its JSON Pointer path", () => {
        const result = validateActionValue(schema, {
            name: "x",
            day: "2026-02-30",
            at: 1.5,
            count: 0,
            ratio: 2,
            tags: ["a", "b", "c"],
            lines: [{qty: "2"}, null, {qty: 1, extra: true}],
            owner: "  ",
            unknownProp: 1,
            "bad name": 1,
        });
        assert.equal(result.value, undefined);
        assert.deepEqual(result.issues, [
            {path: "/unknownProp", message: "is not a property of this object"},
            {path: "", message: "is not a property of this object"},
            {path: "/name", message: "must be at least 2 characters long"},
            {path: "/day", message: "must be a date in the format YYYY-MM-DD"},
            {path: "/at", message: "must be a timestamp in epoch milliseconds"},
            {path: "/count", message: "must be at least 1"},
            {path: "/ratio", message: "must be at most 1.5"},
            {path: "/tags", message: "must contain at most 2 items"},
            {path: "/lines/0/qty", message: "must be an integer"},
            {path: "/lines/1", message: "must not be null"},
            {path: "/lines/2/extra", message: "is not a property of this object"},
            {path: "/owner", message: "must be a record ID of 1 to 128 characters"},
        ]);
        assert.equal(result.issueCount, 12);
    });

    test("checks required properties, types, enums and lengths", () => {
        assert.deepEqual(validateActionValue(schema, {}).issues, [{path: "/name", message: "is required"}]);
        assert.deepEqual(validateActionValue(schema, {name: null}).issues, [{path: "/name", message: "is required"}]);
        assert.deepEqual(validateActionValue(schema, null).issues, [{path: "", message: "must not be null"}]);
        assert.deepEqual(validateActionValue(schema, []).issues, [{path: "", message: "must be an object"}]);
        assert.deepEqual(validateActionValue(schema, {name: 5}).issues, [{path: "/name", message: "must be a string"}]);
        assert.deepEqual(validateActionValue(schema, {name: "abcdef"}).issues,
            [{path: "/name", message: "must be at most 5 characters long"}]);
        // Length counts characters, not UTF-16 code units.
        assert.deepEqual(validateActionValue(schema, {name: "😀😀😀"}).issues, []);
        assert.deepEqual(validateActionValue(schema, {name: "ab", day: "2024-02-29"}).issues, []);
        assert.deepEqual(validateActionValue(schema, {name: "ab", count: 2 ** 53}).issues,
            [{path: "/count", message: "must be an integer"}]);
        assert.deepEqual(validateActionValue(schema, {name: "ab", ratio: "1"}).issues,
            [{path: "/ratio", message: "must be a number"}]);
        assert.deepEqual(validateActionValue(scoreOutput.toJSON(), {score: 1, tier: "D"}).issues,
            [{path: "/tier", message: "must be one of the allowed values"}]);
        assert.deepEqual(validateActionValue(s.object({flag: s.boolean()}).toJSON(), {flag: "true"}).issues,
            [{path: "/flag", message: "must be a boolean"}]);
    });

    test("reports at most 20 problems and counts the rest", () => {
        const list = s.object({items: s.array(s.integer())}).toJSON();
        const result = validateActionValue(list, {items: Array.from({length: 25}, () => "x")});
        assert.equal(result.issues.length, 20);
        assert.equal(result.issueCount, 25);
    });
});

describe("parseActionRunRequest", () => {
    test("accepts input with an optional source and runId", () => {
        assert.deepEqual(parseActionRunRequest({input: {a: 1}}), {input: {a: 1}});
        const request: ActionRunRequest = parseActionRunRequest({
            input: {},
            runId: "run-1",
            source: {type: "agent", agentId: "AG1", sessionId: null, interactive: true},
        });
        assert.deepEqual(request, {
            input: {},
            runId: "run-1",
            source: {type: "agent", agentId: "AG1", sessionId: null, interactive: true},
        });
    });

    test("rejects invalid requests with a 400 error", () => {
        const rejects = (body: Record<string, unknown>, pattern: RegExp): void =>
            assert.throws(() => parseActionRunRequest(body), isRunError(400, "ACTION_REQUEST_INVALID", pattern));
        rejects({}, /input is required/);
        rejects({input: {}, extra: 1}, /Unknown property 'extra'/);
        rejects({input: {}, runId: ""}, /runId must be a non-empty string/);
        rejects({input: {}, source: "process"}, /source must be an object/);
        rejects({input: {}, source: {type: "webhook"}}, /source.type must be/);
        rejects({input: {}, source: {type: "process", agentId: "AG1"}}, /unknown property 'agentId' for type process/);
        rejects({input: {}, source: {type: "process", runAs: "ADMIN"}}, /source.runAs must be/);
        rejects({input: {}, source: {type: "agent", interactive: "yes"}}, /source.interactive must be a boolean/);
        rejects({input: {}, source: {type: "agent", agentId: 1}}, /source.agentId must be a non-empty string/);
    });
});

describe("loadActionDefinitions", () => {
    test("returns an empty list when the export is absent", () => {
        assert.deepEqual(loadActionDefinitions(undefined), []);
    });

    test("keeps valid definitions in order", () => {
        const actions = loadActionDefinitions([scoreLead(), customAction(() => ({ok: true}))]);
        assert.deepEqual(actions.map(action => action.key), ["score_lead", "custom_action"]);
    });

    test("rejects non-arrays, foreign values, duplicate keys and too many actions", () => {
        assert.throws(() => loadActionDefinitions({}), /must be an array/);
        assert.throws(() => loadActionDefinitions([{key: "x"}]), /actions\[0\] is not a defineAction\(\) result/);
        assert.throws(() => loadActionDefinitions([scoreLead(), scoreLead()]),
            /Action key 'score_lead' is exported more than once/);
        const many = Array.from({length: MAX_ACTIONS_PER_PROJECT + 1},
            (_, index) => customAction(() => ({ok: true}), {key: `action_${index}`}));
        assert.throws(() => loadActionDefinitions(many), /at most 50 actions/);
    });
});

describe("runActionLocally", () => {
    test("runs the handler with the checked input and Cogover's context", async () => {
        const seen: SeenCall[] = [];
        const result = await run(scoreLead(seen), {input: {leadId: "LEAD1", rating: 9, strict: null}, runId: "run-1"});

        assert.equal(result.status, "COMPLETED");
        assert.deepEqual(result.output, {score: 90, tier: "A"});
        assert.equal(result.error, null);
        assert.deepEqual(result.input, {leadId: "LEAD1", rating: 9});
        assert.deepEqual(result.action, {
            key: "score_lead",
            effect: "read",
            runId: "run-1",
            source: {
                type: "process",
                processId: "local_process",
                processInfoId: "local_process_info",
                instanceId: "local_process_instance",
                nodeId: "local_node",
                runAs: null,
            },
        });
        assert.ok(result.warnings.some(warning => warning.includes("declared read-only")));
        assert.equal(typeof result.durationMs, "number");

        assert.equal(seen.length, 1);
        const call = seen[0]!;
        assert.deepEqual(call.input, {leadId: "LEAD1", rating: 9});
        assert.deepEqual(call.context.action, {key: "score_lead", runId: "run-1", effect: "read"});
        assert.equal(call.context.invocation.identity, "user");
        assert.equal(call.context.invocation.executionIdentity, "user");
        assert.equal(call.context.invocation.workspace.id, "WS1");
        assert.equal(call.context.invocation.user?.membership.personnelId, "PER1");
        assert.equal(call.context.invocation.source.type, "process");
    });

    test("builds an agent source with the caller as the initiator", async () => {
        const seen: SeenCall[] = [];
        const result = await run(scoreLead(seen), {
            input: {leadId: "LEAD1", rating: 1},
            source: {type: "agent", agentId: "AG1", interactive: true},
        });
        assert.equal(result.status, "COMPLETED");
        assert.deepEqual(result.action.source, {
            type: "agent",
            agentId: "AG1",
            sessionId: null,
            runId: null,
            interactive: true,
            initiatorPersonnelId: "PER1",
        });
        assert.deepEqual(seen[0]?.context.invocation.source, result.action.source);
        assert.match(result.action.runId, /^[0-9a-f-]{36}$/);
    });

    test("defaults the source to the first exposeTo entry", async () => {
        const agentOnly = customAction(() => ({ok: true}), {exposeTo: ["agent"]});
        const result = await run(agentOnly, {input: {}});
        assert.equal(result.action.source.type, "agent");
    });

    test("refuses a source the action is not exposed to", async () => {
        const processOnly = customAction(() => ({ok: true}));
        await assert.rejects(run(processOnly, {input: {}, source: {type: "agent"}}),
            isRunError(403, "ACTION_NOT_EXPOSED", /not exposed to agent; it declares exposeTo process/));
    });

    test("warns that runAs SYSTEM still runs as the Development Session caller", async () => {
        const result = await run(customAction(() => ({ok: true})),
            {input: {}, source: {type: "process", runAs: "SYSTEM"}});
        assert.equal(result.status, "COMPLETED");
        assert.ok(result.warnings.some(warning => warning.includes("runAs SYSTEM")));
        assert.ok(!result.warnings.some(warning => warning.includes("read-only")), "a write action may write");
    });

    test("an invalid input fails with INPUT_INVALID and does not run the handler", async () => {
        const seen: SeenCall[] = [];
        const result = await run(scoreLead(seen), {input: {leadId: "", rating: 11, other: 1}});
        assert.equal(seen.length, 0);
        assert.equal(result.status, "FAILED");
        assert.equal(result.input, null);
        assert.deepEqual(result.error, {
            code: "INPUT_INVALID",
            message: "The action input does not match its schema",
            details: {errors: [
                {path: "/other", message: "is not a property of this object"},
                {path: "/leadId", message: "must be a record ID of 1 to 128 characters"},
                {path: "/rating", message: "must be at most 10"},
            ]},
        });
    });

    test("an output that does not match the schema fails with OUTPUT_INVALID", async () => {
        const result = await run(customAction(() => ({ok: "yes"})), {input: {}});
        assert.equal(result.status, "FAILED");
        assert.equal(result.output, null);
        assert.deepEqual(result.error, {
            code: "OUTPUT_INVALID",
            message: "The action output does not match its schema",
            details: {errors: [{path: "/ok", message: "must be a boolean"}]},
        });
    });

    test("an undefined output is reported as a null root", async () => {
        const result = await run(customAction(() => undefined), {input: {}});
        assert.deepEqual(result.error, {
            code: "OUTPUT_INVALID",
            message: "The action output does not match its schema",
            details: {errors: [{path: "", message: "must not be null"}]},
        });
    });

    test("an output that is not JSON data fails with OUTPUT_INVALID", async () => {
        const result = await run(customAction(() => ({ok: Number.NaN})), {input: {}});
        assert.deepEqual(result.error, {
            code: "OUTPUT_INVALID",
            message: "The action returned a value that is not JSON data",
            details: null,
        });
    });

    test("a handler error is described by the caller", async () => {
        const result = await run(customAction(() => {
            throw new Error("boom");
        }), {input: {}});
        assert.equal(result.status, "FAILED");
        assert.deepEqual(result.error, {
            code: "SCRIPT_ERROR",
            message: "The action handler failed",
            details: {thrown: "boom"},
        });
    });

    test("a handler that exceeds timeoutMs fails with TIMEOUT", async () => {
        const slow = customAction(() => new Promise(resolve => setTimeout(() => resolve({ok: true}), 1_500)),
            {timeoutMs: 1_000});
        const result = await run(slow, {input: {}});
        assert.equal(result.status, "FAILED");
        assert.deepEqual(result.error, {
            code: "TIMEOUT",
            message: "The action exceeded its time limit",
            details: {timeoutMs: 1_000},
        });
        assert.ok(result.warnings.some(warning => warning.includes("time limit")));
        await new Promise(resolve => setTimeout(resolve, 600));
    });
});

describe("local server action routes", () => {
    async function withServer<T>(
        overrides: Partial<LocalServerOptions>,
        body: (base: string) => Promise<T>,
    ): Promise<T> {
        const local = await startLocalServer({
            actions: [scoreLead()],
            projectSlug: "sales",
            port: 0,
            invocation,
            readRecord: async () => null,
            onUnexpectedScriptError: () => undefined,
            ...overrides,
        });
        try {
            return await body(`http://${local.host}:${local.port}`);
        } finally {
            await local.close();
        }
    }

    const post = (url: string, body: unknown): Promise<Response> => fetch(url, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(body),
    });

    interface RunBody {
        status: string;
        output: unknown;
        error: ActionCallError | null;
    }

    test("lists the exported actions with their manifests", async () => {
        await withServer({}, async base => {
            const response = await fetch(`${base}/__cogover/actions`);
            assert.equal(response.status, 200);
            const body = await response.json() as {actions: Array<{key: string; timeoutMs: number; inputSchema: unknown}>};
            assert.deepEqual(body.actions.map(action => [action.key, action.timeoutMs]), [["score_lead", 8000]]);
            assert.deepEqual(body.actions[0]?.inputSchema, scoreInput.toJSON());
        });
    });

    test("runs an action over HTTP", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/__cogover/actions/score_lead`, {input: {leadId: "L1", rating: 6}});
            assert.equal(response.status, 200);
            const body = await response.json() as RunBody;
            assert.equal(body.status, "COMPLETED");
            assert.deepEqual(body.output, {score: 60, tier: "B"});
        });
    });

    test("answers 200 with FAILED for an input the schema refuses", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/__cogover/actions/score_lead`, {input: {rating: 1}});
            assert.equal(response.status, 200);
            const body = await response.json() as RunBody;
            assert.equal(body.status, "FAILED");
            assert.equal(body.error?.code, "INPUT_INVALID");
        });
    });

    test("returns 404 for an unknown action and 400 for an invalid request", async () => {
        await withServer({}, async base => {
            const missing = await post(`${base}/__cogover/actions/missing_action`, {input: {}});
            assert.equal(missing.status, 404);
            assert.deepEqual(await missing.json(), {
                r: 404, code: "ACTION_NOT_FOUND", msg: "Action 'missing_action' is not exported by the project entry point",
            });
            const invalid = await post(`${base}/__cogover/actions/score_lead`, {});
            assert.equal(invalid.status, 400);
            assert.equal((await invalid.json() as {code: string}).code, "ACTION_REQUEST_INVALID");
        });
    });

    test("returns 403 for a source the action is not exposed to", async () => {
        await withServer({actions: [customAction(() => ({ok: true}))]}, async base => {
            const response = await post(`${base}/__cogover/actions/custom_action`,
                {input: {}, source: {type: "agent", agentId: "AG1"}});
            assert.equal(response.status, 403);
            assert.equal((await response.json() as {code: string}).code, "ACTION_NOT_EXPOSED");
        });
    });

    test("returns 405 for wrong methods and 404 for invalid keys", async () => {
        await withServer({}, async base => {
            const wrongRun = await fetch(`${base}/__cogover/actions/score_lead`);
            assert.equal(wrongRun.status, 405);
            assert.equal(wrongRun.headers.get("allow"), "POST");
            const wrongList = await post(`${base}/__cogover/actions`, {});
            assert.equal(wrongList.status, 405);
            assert.equal(wrongList.headers.get("allow"), "GET");
            const badKey = await post(`${base}/__cogover/actions/Score-Lead`, {input: {}});
            assert.equal(badKey.status, 404);
        });
    });

    test("maps handler errors to the codes and safe messages callers receive", async () => {
        const reported: unknown[] = [];
        const throwing = (error: unknown, key: string) => customAction(() => {
            throw error;
        }, {key});
        const actions = [
            throwing(new ValidationError("Lead code has a bad format"), "validation"),
            throwing(new NotFoundError("lead", "L1"), "not_found"),
            throwing(new PermissionDeniedError("denied", {reason: "OBJECT_SERVER_PERMISSION_DENIED", api: "data"}),
                "permission"),
            throwing(new RateLimitError("too many", {budget: "capabilityCalls", limit: 100, used: 100}), "rate_limited"),
            throwing(new Error("secret detail"), "plain_error"),
        ];
        await withServer({actions, onUnexpectedScriptError: error => reported.push(error)}, async base => {
            const call = async (key: string): Promise<ActionCallError | null> =>
                (await (await post(`${base}/__cogover/actions/${key}`, {input: {}})).json() as RunBody).error;

            assert.deepEqual(await call("validation"), {
                code: "SCRIPT_ERROR",
                message: "The input or operation parameters are invalid.",
                details: {scriptErrorCode: "VALIDATION_ERROR"},
            });
            assert.deepEqual(await call("not_found"), {
                code: "SCRIPT_ERROR",
                message: "The requested record, object, or route was not found.",
                details: {scriptErrorCode: "NOT_FOUND"},
            });
            assert.deepEqual(await call("permission"), {
                code: "PERMISSION_DENIED",
                message: "The caller does not have permission to perform the requested data operation.",
                details: {reason: "OBJECT_SERVER_PERMISSION_DENIED", api: "data"},
            });
            assert.deepEqual(await call("rate_limited"), {
                code: "RATE_LIMITED",
                message: "The request limit has been exceeded. Please try again later.",
                details: {budget: "capabilityCalls"},
            });
            assert.deepEqual(await call("plain_error"), {
                code: "SCRIPT_ERROR",
                message: "The action handler failed",
                details: null,
            });
            assert.equal(reported.length, 1, "only the unexpected error is reported");
            assert.match(String(reported[0]), /secret detail/);
        });
    });

    test("serves actions next to the HTTP handler", async () => {
        const handler = async (): Promise<string> => JSON.stringify({ok: true});
        await withServer({handler}, async base => {
            const route = await post(`${base}/api/v1/ts-projects/sales`, {});
            assert.deepEqual(await route.json(), {ok: true});
            const action = await post(`${base}/__cogover/actions/score_lead`, {input: {leadId: "L1", rating: 0}});
            assert.equal((await action.json() as RunBody).status, "COMPLETED");
        });
    });

    test("project routes respond 404 when the project only has actions", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/api/v1/ts-projects/sales`, {});
            assert.equal(response.status, 404);
            assert.match((await response.json() as {msg: string}).msg, /no HTTP handler/);
        });
    });
});
