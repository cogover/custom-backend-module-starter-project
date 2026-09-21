import assert from "node:assert/strict";
import test, {describe} from "node:test";
import {
    defineTrigger,
    PermissionDeniedError,
    type InvocationContext,
    type TriggerConfig,
    type TriggerDefinition,
    type TriggerHandler,
    type TriggerOperation,
} from "@cogover/sdk";
import {startLocalServer, type LocalServerOptions} from "./local-server.js";
import {
    loadTriggerDefinitions,
    parseTriggerRunRequest,
    runTriggerLocally,
    TriggerRunError,
    type RecordReader,
    type StoredRecord,
} from "./trigger-runner.js";

/**
 * Schema of the sample Object used by these tests. Declared here, not through the
 * `WorkspaceObjects` augmentation, so the tests type-check whatever Objects the
 * project declares in `src/workspace.d.ts`.
 */
interface TestSchema {
    order: {
        status: string | null;
        amount: number | null;
        customer: {id: string; name: string; objectSlug: string} | string | null;
        approval_level: string | null;
    };
}

function defineTestTrigger<TOperation extends TriggerOperation>(
    config: TriggerConfig<"order", TOperation, TestSchema>,
    handler: TriggerHandler<"order", TOperation, TestSchema>,
): TriggerDefinition {
    return defineTrigger<"order", TOperation, TestSchema>(config, handler);
}

const invocation: InvocationContext = Object.freeze({
    identity: "user",
    workspace: {id: "WS1", name: "Test Workspace"},
    user: {accountId: "AC1", membership: {personnelId: "PER1"}},
});

const customer = {id: "CUS1", name: "Acme", objectSlug: "account"};
const stored: Readonly<Record<string, StoredRecord>> = {
    REC1: {id: "REC1", fields: {status: "draft", amount: 10, customer, secret: "hidden"}},
    REC2: {id: "REC2", fields: {status: "confirmed", amount: 500}},
};

interface ReadCall {
    objectSlug: string;
    id: string;
    fields: readonly string[];
}

function reader(calls: ReadCall[] = []): RecordReader {
    return async (objectSlug, id, fields) => {
        calls.push({objectSlug, id, fields});
        return stored[id] ?? null;
    };
}

function creditCheck(): TriggerDefinition {
    return defineTestTrigger({
        key: "order_credit_check",
        object: "order",
        timing: "beforeChange",
        operations: ["create", "update", "delete"],
        fields: ["status", "amount", "customer"],
        changedFields: ["status", "amount"],
        when: {op: "=", field: "status", params: "confirmed"},
        writableFields: ["approval_level"],
    }, async ({records, trigger}) => {
        for (const record of records) {
            if (record.new === null) continue;
            const amount = typeof record.new.amount === "number" ? record.new.amount : 0;
            if (amount > 100) {
                record.addError("amount", "AMOUNT_TOO_LARGE", `Amount exceeds the limit for ${trigger.operation}`);
                continue;
            }
            record.new.approval_level = trigger.operation === "create" ? "new" : "standard";
        }
    });
}

function run(body: Record<string, unknown>, definition = creditCheck(), readRecord = reader()) {
    return runTriggerLocally({
        definition,
        request: parseTriggerRunRequest(body),
        projectSlug: "orders",
        invocation,
        readRecord,
    });
}

function isRunError(status: number, code: string, pattern: RegExp) {
    return (error: unknown): boolean => {
        assert.ok(error instanceof TriggerRunError, `expected TriggerRunError, got ${String(error)}`);
        assert.equal(error.httpStatus, status);
        assert.equal(error.code, code);
        assert.match(error.message, pattern);
        return true;
    };
}

describe("parseTriggerRunRequest", () => {
    test("accepts the single-record shorthand", () => {
        assert.deepEqual(
            parseTriggerRunRequest({operation: "update", recordId: "REC1", changes: {status: "confirmed"}}),
            {operation: "update", records: [{recordId: "REC1", changes: {status: "confirmed"}}]},
        );
        assert.deepEqual(parseTriggerRunRequest({operation: "delete", recordId: "REC1"}),
            {operation: "delete", records: [{recordId: "REC1"}]});
        assert.deepEqual(parseTriggerRunRequest({operation: "create", changes: {status: "new"}}),
            {operation: "create", records: [{changes: {status: "new"}}]});
    });

    test("accepts a records array", () => {
        assert.deepEqual(
            parseTriggerRunRequest({operation: "update", records: [
                {recordId: "REC1", changes: {status: "confirmed"}},
                {recordId: "REC2", changes: {}},
            ]}),
            {operation: "update", records: [
                {recordId: "REC1", changes: {status: "confirmed"}},
                {recordId: "REC2", changes: {}},
            ]},
        );
    });

    test("rejects invalid input with a 400 error", () => {
        const rejects = (body: Record<string, unknown>, pattern: RegExp): void =>
            assert.throws(() => parseTriggerRunRequest(body), isRunError(400, "TRIGGER_REQUEST_INVALID", pattern));
        rejects({}, /operation must be/);
        rejects({operation: "upsert"}, /operation must be/);
        rejects({operation: "update", changes: {}}, /recordId must be the id of a stored record for update/);
        rejects({operation: "delete", recordId: "bad id"}, /recordId must be the id of a stored record for delete/);
        rejects({operation: "create", recordId: "REC1", changes: {}}, /recordId is not allowed for create/);
        rejects({operation: "create"}, /changes is required for create/);
        rejects({operation: "update", recordId: "REC1", changes: "x"}, /must be an object of field values/);
        rejects({operation: "delete", recordId: "REC1", changes: {}}, /changes is not allowed for delete/);
        rejects({operation: "update", recordId: "REC1", changes: {id: "X"}}, /cannot contain 'id'/);
        rejects({operation: "update", recordId: "REC1", changes: {"bad-slug": 1}}, /invalid field slug 'bad-slug'/);
        rejects({operation: "update", recordId: "REC1", changes: {}, extra: 1}, /Unknown property 'extra'/);
        rejects({operation: "update", records: [{recordId: "REC1", changes: {}, old: {}}]}, /unknown property 'old'/);
        rejects({operation: "update", records: ["REC1"]}, /records\[0\] must be an object/);
        rejects({operation: "update", records: "REC1"}, /records must be an array/);
        rejects({operation: "update", records: []}, /At least one record/);
        rejects({operation: "update", records: [], recordId: "REC1"}, /not both/);
        rejects({operation: "create", records: Array.from({length: 201}, () => ({changes: {}}))}, /At most 200/);
    });
});

describe("runTriggerLocally", () => {
    test("update reads the stored record, applies the changes and returns the handler result", async () => {
        const calls: ReadCall[] = [];
        const result = await run({
            operation: "update",
            recordId: "REC1",
            changes: {status: "confirmed", amount: 10, secret: "changed"},
        }, creditCheck(), reader(calls));

        assert.deepEqual(calls, [{objectSlug: "order", id: "REC1", fields: ["status", "amount", "customer"]}]);
        assert.equal(result.trigger.key, "order_credit_check");
        assert.equal(result.trigger.timing, "beforeChange");
        assert.equal(result.trigger.operation, "update");
        assert.equal(result.trigger.objectSlug, "order");
        assert.equal(typeof result.trigger.changeId, "string");
        assert.deepEqual(result.input.records, [{
            key: "0",
            id: "REC1",
            new: {id: "REC1", status: "confirmed", amount: 10, customer},
            old: {id: "REC1", status: "draft", amount: 10, customer},
            changedFields: ["status"],
        }]);
        assert.deepEqual(result.results, [{key: "0", changes: {approval_level: "standard"}}]);
        assert.ok(result.warnings.some(warning => warning.includes("field 'secret'")), "ignored field is reported");
        assert.ok(result.warnings.some(warning => warning.includes("'when' filter")), "when is reported");
        assert.ok(result.warnings.some(warning => warning.includes("read-only")), "before-change note is reported");
        assert.ok(!result.warnings.some(warning => warning.includes("changedFields")), "status changed");
    });

    test("create has neither an id nor old values", async () => {
        const calls: ReadCall[] = [];
        const result = await run({
            operation: "create",
            changes: {status: "new", amount: 5, customer: null},
        }, creditCheck(), reader(calls));

        assert.deepEqual(calls, []);
        assert.deepEqual(result.input.records, [{
            key: "0",
            id: null,
            new: {status: "new", amount: 5, customer: null},
            old: null,
            changedFields: ["status", "amount"],
        }]);
        assert.deepEqual(result.results, [{key: "0", changes: {approval_level: "new"}}]);
    });

    test("delete passes the stored record as old and new is null", async () => {
        const result = await run({operation: "delete", recordId: "REC1"});
        assert.deepEqual(result.input.records, [{
            key: "0",
            id: "REC1",
            new: null,
            old: {id: "REC1", status: "draft", amount: 10, customer},
            changedFields: [],
        }]);
        assert.deepEqual(result.results, []);
    });

    test("returns handler errors per record", async () => {
        const result = await run({operation: "update", records: [
            {recordId: "REC1", changes: {amount: 20}},
            {recordId: "REC2", changes: {amount: 600}},
        ]});
        assert.deepEqual(result.input.records.map(record => record.key), ["0", "1"]);
        assert.deepEqual(result.results, [
            {key: "0", changes: {approval_level: "standard"}},
            {key: "1", errors: [{field: "amount", code: "AMOUNT_TOO_LARGE", message: "Amount exceeds the limit for update"}]},
        ]);
    });

    test("warns when none of the trigger's changedFields changed", async () => {
        const result = await run({operation: "update", recordId: "REC1", changes: {customer: "CUS9", status: "draft"}});
        assert.deepEqual(result.input.records[0]?.changedFields, ["customer"]);
        assert.ok(result.warnings.some(warning => warning.includes("none of changedFields [status, amount] changed")));
    });

    test("adds the onEnter note only for onEnter triggers", async () => {
        const onEnter = defineTestTrigger({
            key: "order_followup",
            object: "order",
            timing: "afterChange",
            operations: ["update"],
            fields: ["status"],
            when: {op: "=", field: "status", params: "confirmed"},
            runWhen: "onEnter",
        }, async () => undefined);
        const result = await run({operation: "update", recordId: "REC1", changes: {status: "confirmed"}}, onEnter);
        assert.equal(result.trigger.timing, "afterChange");
        assert.ok(result.warnings.some(warning => warning.includes("runWhen 'onEnter'")));
        assert.ok(!result.warnings.some(warning => warning.includes("read-only")), "after-change may write");
    });

    test("rejects an operation the trigger does not declare", async () => {
        const updateOnly = defineTestTrigger({
            key: "update_only",
            object: "order",
            timing: "beforeChange",
            operations: ["update"],
            fields: ["status"],
        }, async () => undefined);
        await assert.rejects(run({operation: "create", changes: {}}, updateOnly),
            isRunError(400, "TRIGGER_OPERATION_NOT_SUPPORTED", /does not run on create; it declares operations update/));
    });

    test("reports a record that cannot be read", async () => {
        await assert.rejects(run({operation: "update", recordId: "MISSING", changes: {}}),
            isRunError(404, "RECORD_NOT_FOUND", /Record 'MISSING' of object 'order'/));
    });

    test("propagates handler failures unchanged", async () => {
        const failing = defineTestTrigger({
            key: "failing",
            object: "order",
            timing: "afterChange",
            operations: ["create"],
            fields: ["status"],
        }, async () => {
            throw new Error("boom");
        });
        await assert.rejects(run({operation: "create", changes: {}}, failing), /boom/);
    });
});

describe("loadTriggerDefinitions", () => {
    test("returns an empty list when the export is absent", () => {
        assert.deepEqual(loadTriggerDefinitions(undefined), []);
    });

    test("keeps valid definitions in order", () => {
        const first = creditCheck();
        const second = defineTestTrigger({
            key: "order_followup", object: "order", timing: "afterChange", operations: ["update"], fields: ["status"],
        }, async () => undefined);
        assert.deepEqual(loadTriggerDefinitions([first, second]).map(trigger => trigger.key),
            ["order_credit_check", "order_followup"]);
    });

    test("rejects non-arrays, foreign values and duplicate keys", () => {
        assert.throws(() => loadTriggerDefinitions({}), /must be an array/);
        assert.throws(() => loadTriggerDefinitions([{key: "x"}]), /triggers\[0\] is not a defineTrigger\(\) result/);
        assert.throws(() => loadTriggerDefinitions([creditCheck(), creditCheck()]),
            /Trigger key 'order_credit_check' is exported more than once/);
    });
});

describe("local server trigger routes", () => {
    async function withServer<T>(
        overrides: Partial<LocalServerOptions>,
        body: (base: string) => Promise<T>,
    ): Promise<T> {
        const local = await startLocalServer({
            triggers: [creditCheck()],
            projectSlug: "orders",
            port: 0,
            invocation,
            readRecord: reader(),
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

    test("lists the exported triggers with their normalized configuration", async () => {
        await withServer({}, async base => {
            const response = await fetch(`${base}/__cogover/triggers`);
            assert.equal(response.status, 200);
            const body = await response.json() as {triggers: Array<{key: string; order: number}>};
            assert.deepEqual(body.triggers.map(trigger => [trigger.key, trigger.order]), [["order_credit_check", 5000]]);
        });
    });

    test("runs a trigger over HTTP", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/__cogover/triggers/order_credit_check`,
                {operation: "update", recordId: "REC1", changes: {status: "confirmed"}});
            assert.equal(response.status, 200);
            const body = await response.json() as {results: unknown; warnings: string[]};
            assert.deepEqual(body.results, [{key: "0", changes: {approval_level: "standard"}}]);
            assert.ok(Array.isArray(body.warnings));
        });
    });

    test("returns 404 for an unknown trigger key", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/__cogover/triggers/missing_trigger`, {operation: "create", changes: {}});
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), {
                r: 404, code: "TRIGGER_NOT_FOUND", msg: "Trigger 'missing_trigger' is not exported by the project entry point",
            });
        });
    });

    test("returns 400 for an invalid run request", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/__cogover/triggers/order_credit_check`, {operation: "update"});
            assert.equal(response.status, 400);
            const body = await response.json() as {code: string};
            assert.equal(body.code, "TRIGGER_REQUEST_INVALID");
        });
    });

    test("returns 405 for wrong methods and 404 for other tooling paths", async () => {
        await withServer({}, async base => {
            const wrongRun = await fetch(`${base}/__cogover/triggers/order_credit_check`);
            assert.equal(wrongRun.status, 405);
            assert.equal(wrongRun.headers.get("allow"), "POST");
            const wrongList = await post(`${base}/__cogover/triggers`, {});
            assert.equal(wrongList.status, 405);
            assert.equal(wrongList.headers.get("allow"), "GET");
            const unknown = await fetch(`${base}/__cogover/other`);
            assert.equal(unknown.status, 404);
            const badKey = await post(`${base}/__cogover/triggers/9bad`, {});
            assert.equal(badKey.status, 404);
        });
    });

    test("project routes respond 404 when the project has no HTTP handler", async () => {
        await withServer({}, async base => {
            const response = await post(`${base}/api/v1/ts-projects/orders`, {});
            assert.equal(response.status, 404);
            const body = await response.json() as {msg: string};
            assert.match(body.msg, /no HTTP handler/);
        });
    });

    test("maps SDK errors thrown while reading the record", async () => {
        const denied: RecordReader = async () => {
            throw new PermissionDeniedError("denied", {reason: "OBJECT_SERVER_PERMISSION_DENIED", api: "data"});
        };
        await withServer({readRecord: denied}, async base => {
            const response = await post(`${base}/__cogover/triggers/order_credit_check`,
                {operation: "delete", recordId: "REC1"});
            assert.equal(response.status, 403);
            const body = await response.json() as {code: string};
            assert.equal(body.code, "PERMISSION_DENIED");
        });
    });

    test("serves the HTTP handler next to the triggers", async () => {
        const handler = async (inputJson: string): Promise<string> => {
            const input = JSON.parse(inputJson) as {__context: {source: string}};
            return JSON.stringify({source: input.__context.source});
        };
        await withServer({handler}, async base => {
            const response = await post(`${base}/api/v1/ts-projects/orders`, {});
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {source: "http"});
        });
    });

    test("requires a handler or a trigger", async () => {
        await assert.rejects(startLocalServer({projectSlug: "orders", port: 0, invocation}),
            /A project handler or at least one record trigger is required/);
    });
});
