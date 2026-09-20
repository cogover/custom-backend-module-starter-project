import {randomUUID} from "node:crypto";
import {
    CogoverApiError,
    type InvocationContext,
    type TriggerDefinition,
    type TriggerManifest,
    type TriggerOperation,
} from "@cogover/sdk";

/**
 * Runs one record trigger of the project on demand, with real records read through
 * the active Development Session. Cogover only sends real record events to the
 * active published version, so this runner is how a trigger handler is exercised
 * on a developer machine before it is published.
 */

const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELD_SLUG = /^[A-Za-z_][A-Za-z0-9_]{0,354}$/;
const OPERATIONS: ReadonlySet<string> = new Set(["create", "update", "delete"]);
const REQUEST_KEYS: ReadonlySet<string> = new Set(["operation", "records", "recordId", "changes"]);
const RECORD_KEYS: ReadonlySet<string> = new Set(["recordId", "changes"]);
/** Same per-call limit as Cogover, which splits larger changes into several calls. */
export const MAX_RECORDS_PER_RUN = 200;

const WIRE_TIMING = {beforeChange: "BEFORE_CHANGE", afterChange: "AFTER_CHANGE"} as const;
const WIRE_OPERATION = {create: "CREATE", update: "UPDATE", delete: "DELETE"} as const;

export type FieldValues = Record<string, unknown>;

export interface TriggerRunRecordInput {
    /** Stored record to read; required for update and delete, absent for create. */
    readonly recordId?: string;
    /** Field values of the change; the whole new record for create, overrides for update. */
    readonly changes?: Readonly<FieldValues>;
}

export interface TriggerRunRequest {
    readonly operation: TriggerOperation;
    readonly records: readonly TriggerRunRecordInput[];
}

export interface StoredRecord {
    readonly id: string;
    readonly fields: Readonly<FieldValues>;
}

/** Reads one stored record; resolves null when it does not exist or is not readable. */
export type RecordReader = (
    objectSlug: string,
    id: string,
    fields: readonly string[],
) => Promise<StoredRecord | null>;

/** One record exactly as the handler receives it. */
export interface TriggerInputRecord {
    readonly key: string;
    readonly id: string | null;
    readonly new: FieldValues | null;
    readonly old: FieldValues | null;
    readonly changedFields: readonly string[];
}

export interface TriggerRunOptions {
    readonly definition: TriggerDefinition;
    readonly request: TriggerRunRequest;
    readonly projectSlug: string;
    readonly invocation: InvocationContext;
    readonly readRecord: RecordReader;
}

export interface TriggerRunResult {
    readonly trigger: {
        readonly key: string;
        readonly timing: TriggerManifest["timing"];
        readonly operation: TriggerOperation;
        readonly objectSlug: string;
        readonly changeId: string;
    };
    readonly input: {readonly records: readonly TriggerInputRecord[]};
    /** Per-record `changes` and `errors` in the format the handler returns to Cogover. */
    readonly results: readonly unknown[];
    readonly warnings: readonly string[];
}

/** A request the runner rejects before the handler runs; rendered as an HTTP error. */
export class TriggerRunError extends Error {
    constructor(readonly httpStatus: number, readonly code: string, message: string) {
        super(message);
        this.name = "TriggerRunError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(message: string): TriggerRunError {
    return new TriggerRunError(400, "TRIGGER_REQUEST_INVALID", message);
}

export function isTriggerDefinition(value: unknown): value is TriggerDefinition {
    return isRecord(value)
        && typeof value.key === "string"
        && isRecord(value.config)
        && typeof value.__cogoverTriggerHandler === "function";
}

/** Validates the `triggers` export of the project entry point; absent means no triggers. */
export function loadTriggerDefinitions(value: unknown): readonly TriggerDefinition[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new Error("The triggers export of the project entry point must be an array of defineTrigger() results");
    }
    const keys = new Set<string>();
    return value.map((item, index) => {
        if (!isTriggerDefinition(item)) {
            throw new Error(`triggers[${index}] is not a defineTrigger() result`);
        }
        if (keys.has(item.key)) throw new Error(`Trigger key '${item.key}' is exported more than once`);
        keys.add(item.key);
        return item;
    });
}

export function findTrigger(
    triggers: readonly TriggerDefinition[],
    key: string,
): TriggerDefinition | undefined {
    return triggers.find(trigger => trigger.key === key);
}

export function triggerManifests(triggers: readonly TriggerDefinition[]): readonly TriggerManifest[] {
    return triggers.map(trigger => trigger.config);
}

function parseChanges(value: unknown, label: string): FieldValues {
    if (!isRecord(value)) throw invalidRequest(`${label} must be an object of field values`);
    for (const field of Object.keys(value)) {
        if (field === "id") throw invalidRequest(`${label} cannot contain 'id'; use recordId to select the record`);
        if (!FIELD_SLUG.test(field)) throw invalidRequest(`${label} contains an invalid field slug '${field}'`);
    }
    return {...value};
}

function parseRecordInput(raw: unknown, index: number, operation: TriggerOperation): TriggerRunRecordInput {
    const label = `records[${index}]`;
    if (!isRecord(raw)) throw invalidRequest(`${label} must be an object`);
    for (const key of Object.keys(raw)) {
        if (!RECORD_KEYS.has(key)) throw invalidRequest(`${label} has an unknown property '${key}'`);
    }
    const result: {recordId?: string; changes?: FieldValues} = {};
    if (operation === "create") {
        if (raw.recordId !== undefined) {
            throw invalidRequest(`${label}.recordId is not allowed for create: the record has no id yet`);
        }
    } else {
        if (typeof raw.recordId !== "string" || !RECORD_ID.test(raw.recordId)) {
            throw invalidRequest(`${label}.recordId must be the id of a stored record for ${operation}`);
        }
        result.recordId = raw.recordId;
    }
    if (operation === "delete") {
        if (raw.changes !== undefined) {
            throw invalidRequest(`${label}.changes is not allowed for delete: the record is removed as stored`);
        }
    } else {
        if (raw.changes === undefined) {
            throw invalidRequest(`${label}.changes is required for ${operation}`);
        }
        result.changes = parseChanges(raw.changes, `${label}.changes`);
    }
    return result;
}

/**
 * Accepts either `records: [{recordId, changes}, ...]` or the single-record shorthand
 * `recordId` and `changes` at the top level.
 */
export function parseTriggerRunRequest(body: Record<string, unknown>): TriggerRunRequest {
    for (const key of Object.keys(body)) {
        if (!REQUEST_KEYS.has(key)) throw invalidRequest(`Unknown property '${key}'`);
    }
    const operation = body.operation;
    if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
        throw invalidRequest("operation must be \"create\", \"update\" or \"delete\"");
    }
    let rawRecords: readonly unknown[];
    if (body.records !== undefined) {
        if (body.recordId !== undefined || body.changes !== undefined) {
            throw invalidRequest("Use either records or the top-level recordId/changes shorthand, not both");
        }
        if (!Array.isArray(body.records)) throw invalidRequest("records must be an array");
        rawRecords = body.records;
    } else {
        const shorthand: Record<string, unknown> = {};
        if (body.recordId !== undefined) shorthand.recordId = body.recordId;
        if (body.changes !== undefined) shorthand.changes = body.changes;
        rawRecords = [shorthand];
    }
    if (rawRecords.length === 0) throw invalidRequest("At least one record is required");
    if (rawRecords.length > MAX_RECORDS_PER_RUN) {
        throw invalidRequest(`At most ${MAX_RECORDS_PER_RUN} records are accepted per call`);
    }
    const typedOperation = operation as TriggerOperation;
    return {
        operation: typedOperation,
        records: rawRecords.map((raw, index) => parseRecordInput(raw, index, typedOperation)),
    };
}

function jsonEquals(left: unknown, right: unknown): boolean {
    const a = left === undefined ? null : left;
    const b = right === undefined ? null : right;
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, index) => jsonEquals(item, b[index]));
    }
    const leftRecord = a as Record<string, unknown>;
    const rightRecord = b as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length
        && keys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key)
            && jsonEquals(leftRecord[key], rightRecord[key]));
}

/** Keeps only the trigger's payload fields, as Cogover does; other fields are reported. */
function deliverableChanges(
    changes: Readonly<FieldValues> | undefined,
    manifest: TriggerManifest,
    recordKey: string,
    warnings: Set<string>,
): FieldValues {
    const result: FieldValues = {};
    if (changes === undefined) return result;
    const fields = new Set(manifest.fields);
    for (const [field, value] of Object.entries(changes)) {
        if (!fields.has(field)) {
            warnings.add(`Record '${recordKey}': field '${field}' is not listed in the trigger's fields, `
                + "so Cogover would not deliver it in record.new; it was ignored.");
            continue;
        }
        result[field] = value;
    }
    return result;
}

function storedValues(stored: StoredRecord, manifest: TriggerManifest): FieldValues {
    const result: FieldValues = {id: stored.id};
    for (const field of manifest.fields) {
        if (Object.prototype.hasOwnProperty.call(stored.fields, field)) result[field] = stored.fields[field];
    }
    return result;
}

async function buildInputRecord(
    input: TriggerRunRecordInput,
    index: number,
    options: TriggerRunOptions,
    warnings: Set<string>,
): Promise<TriggerInputRecord> {
    const manifest = options.definition.config;
    const operation = options.request.operation;
    const key = String(index);
    const changes = deliverableChanges(input.changes, manifest, key, warnings);

    if (operation === "create") {
        const created = {...changes};
        const changedFields = Object.keys(created).filter(field => created[field] !== null && created[field] !== undefined);
        return {key, id: null, new: created, old: null, changedFields};
    }

    const recordId = input.recordId ?? "";
    const stored = await options.readRecord(manifest.object, recordId, manifest.fields);
    if (stored === null) {
        throw new TriggerRunError(404, "RECORD_NOT_FOUND",
            `Record '${recordId}' of object '${manifest.object}' was not found or is not readable with the Development Session identity`);
    }
    const old = storedValues(stored, manifest);
    if (operation === "delete") {
        return {key, id: stored.id, new: null, old, changedFields: []};
    }

    const updated: FieldValues = {...old, ...changes};
    const changedFields = Object.keys(changes).filter(field => !jsonEquals(old[field], changes[field]));
    const watched = manifest.changedFields;
    if (watched !== undefined && !changedFields.some(field => watched.includes(field))) {
        warnings.add(`Record '${key}': none of changedFields [${watched.join(", ")}] changed, `
            + "so Cogover would not run this trigger for it.");
    }
    return {key, id: stored.id, new: updated, old, changedFields};
}

function staticWarnings(manifest: TriggerManifest, warnings: Set<string>): void {
    if (manifest.when !== undefined) {
        warnings.add("The 'when' filter is not evaluated locally; in Cogover this trigger runs only for records that match it.");
    }
    if (manifest.runWhen === "onEnter") {
        warnings.add("runWhen 'onEnter' is not evaluated locally; in Cogover this trigger runs only when a record starts matching 'when'.");
    }
    if (manifest.timing === "beforeChange") {
        warnings.add("Before-change handlers are read-only in Cogover, but a local Development Session does not enforce this. "
            + "Start cogover-dev run with --allow-writes=false to catch writes.");
    }
}

function parseHandlerOutput(outputJson: string): readonly unknown[] {
    let output: unknown;
    try {
        output = JSON.parse(outputJson);
    } catch {
        throw new TriggerRunError(422, "TRIGGER_RESPONSE_INVALID", "The trigger handler returned invalid JSON");
    }
    if (!isRecord(output) || !Array.isArray(output.results)) {
        throw new TriggerRunError(422, "TRIGGER_RESPONSE_INVALID", "The trigger handler returned an invalid result");
    }
    return output.results;
}

/**
 * Builds the same input Cogover sends to the trigger and runs the handler once.
 * Errors thrown by the handler propagate unchanged so the caller can render them.
 */
export async function runTriggerLocally(options: TriggerRunOptions): Promise<TriggerRunResult> {
    const manifest = options.definition.config;
    const operation = options.request.operation;
    if (!manifest.operations.includes(operation)) {
        throw new TriggerRunError(400, "TRIGGER_OPERATION_NOT_SUPPORTED",
            `Trigger '${manifest.key}' does not run on ${operation}; it declares operations ${manifest.operations.join(", ")}`);
    }
    const warnings = new Set<string>();
    staticWarnings(manifest, warnings);
    const records: TriggerInputRecord[] = [];
    for (const [index, input] of options.request.records.entries()) {
        records.push(await buildInputRecord(input, index, options, warnings));
    }

    const changeId = randomUUID();
    const {invocation} = options;
    const input = {
        __context: {
            projectSlug: options.projectSlug,
            workspaceId: invocation.workspace.id,
            workspace: invocation.workspace,
            source: "trigger",
            trigger: {
                id: `local_${manifest.key}`,
                key: manifest.key,
                timing: WIRE_TIMING[manifest.timing],
                operation: WIRE_OPERATION[operation],
                objectSlug: manifest.object,
                changeId,
            },
            executionIdentity: invocation.identity,
            user: invocation.user,
        },
        records,
    };
    const results = parseHandlerOutput(await options.definition.__cogoverTriggerHandler(JSON.stringify(input)));
    return {
        trigger: {key: manifest.key, timing: manifest.timing, operation, objectSlug: manifest.object, changeId},
        input: {records},
        results,
        warnings: [...warnings],
    };
}

/** Reads records through the Development Session bridge that `cogover-dev run` installs. */
export function bridgeRecordReader(): RecordReader {
    return async (objectSlug, id, fields) => {
        const bridge = (globalThis as typeof globalThis & {
            __cogoverBridgeCall?: (requestJson: string) => Promise<string>;
        }).__cogoverBridgeCall;
        if (typeof bridge !== "function") {
            throw new Error("Record reads are unavailable. Start this server with cogover-dev run.");
        }
        const responseJson = await bridge(JSON.stringify({
            version: 1,
            operation: "records.get",
            payload: {objectSlug, id, fields},
        }));
        let response: unknown;
        try {
            response = JSON.parse(responseJson);
        } catch {
            throw new CogoverApiError("INVALID_BRIDGE_RESPONSE", "The Development Session returned invalid JSON for records.get");
        }
        if (!isRecord(response)) {
            throw new CogoverApiError("INVALID_BRIDGE_RESPONSE", "The Development Session returned an invalid records.get response");
        }
        if (response.ok === true) {
            const data = response.data;
            if (data === null || data === undefined) return null;
            if (!isRecord(data) || typeof data.id !== "string" || !isRecord(data.fields)) {
                throw new CogoverApiError("INVALID_BRIDGE_RESPONSE", "The Development Session returned an invalid record");
            }
            return {id: data.id, fields: data.fields};
        }
        const error = isRecord(response.error) ? response.error : {};
        throw new CogoverApiError(
            typeof error.code === "string" ? error.code : "COGOVER_API_ERROR",
            typeof error.message === "string" ? error.message : "records.get failed",
            error.details,
        );
    };
}
