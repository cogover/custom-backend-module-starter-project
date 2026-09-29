import {randomUUID} from "node:crypto";
import {performance} from "node:perf_hooks";
import type {
    ActionDefinition,
    ActionEffect,
    ActionManifest,
    ActionSource,
    AgentActionSource,
    InvocationContext,
    JsonSchema,
    ProcessActionRunAs,
    ProcessActionSource,
} from "@cogover/sdk";

/**
 * Runs one Custom Module Action of the project on demand, the way a Process node or an
 * AI Agent tool calls it in Cogover: the input is checked against the action's input
 * schema before the handler runs, and the output against its output schema after the
 * handler returns. Cogover only offers the actions of the active published version to
 * Processes and AI Agents, so this runner is how an action handler is exercised on a
 * developer machine before it is published.
 */

const ACTION_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const REQUEST_KEYS: ReadonlySet<string> = new Set(["input", "source", "runId"]);
const PROCESS_SOURCE_KEYS: ReadonlySet<string> = new Set([
    "type", "processId", "processInfoId", "instanceId", "nodeId", "runAs",
]);
const AGENT_SOURCE_KEYS: ReadonlySet<string> = new Set([
    "type", "agentId", "sessionId", "runId", "interactive", "initiatorPersonnelId",
]);
const PROCESS_RUN_AS: ReadonlySet<string> = new Set(["PROCESS_STARTER", "PERSONNEL", "SYSTEM"]);
const MAX_ID_LENGTH = 128;
/** Same limit as Cogover, which refuses to publish a version that declares more actions. */
export const MAX_ACTIONS_PER_PROJECT = 50;
/** Cogover reports at most this many problems of one value; `errorCount` gives the total. */
export const MAX_REPORTED_ERRORS = 20;
const DEFAULT_MAX_LENGTH = 10_000;
const DEFAULT_MAX_ITEMS = 1_000;
const MAX_RECORD_ID_CHARS = 128;

export type ActionCallStatus = "COMPLETED" | "FAILED";

/** An error as the calling Process node or AI Agent receives it. */
export interface ActionCallError {
    readonly code: string;
    readonly message: string;
    readonly details: Readonly<Record<string, unknown>> | null;
}

export interface ActionRunRequest {
    /** Action input as the caller sends it; checked against the input schema. */
    readonly input: unknown;
    /** Caller metadata; placeholders fill what the request leaves out. */
    readonly source?: Readonly<Record<string, unknown>>;
    readonly runId?: string;
}

export interface ActionRunOptions {
    readonly definition: ActionDefinition;
    readonly request: ActionRunRequest;
    readonly projectSlug: string;
    readonly invocation: InvocationContext;
    /** Turns an error thrown by the handler into the error the caller receives. */
    readonly describeHandlerError: (error: unknown) => ActionCallError;
}

export interface ActionRunResult {
    readonly action: {
        readonly key: string;
        readonly effect: ActionEffect;
        readonly runId: string;
        readonly source: ActionSource;
    };
    /** The input exactly as the handler received it; `null` when the input was refused. */
    readonly input: unknown;
    readonly status: ActionCallStatus;
    /** The output as the caller receives it; `null` unless the call completed. */
    readonly output: unknown;
    readonly error: ActionCallError | null;
    readonly durationMs: number;
    readonly warnings: readonly string[];
}

/** A request the runner refuses before the action runs; rendered as an HTTP error. */
export class ActionRunError extends Error {
    constructor(readonly httpStatus: number, readonly code: string, message: string) {
        super(message);
        this.name = "ActionRunError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidRequest(message: string): ActionRunError {
    return new ActionRunError(400, "ACTION_REQUEST_INVALID", message);
}

export function isActionDefinition(value: unknown): value is ActionDefinition {
    return isRecord(value)
        && typeof value.key === "string"
        && isRecord(value.config)
        && typeof value.__cogoverActionHandler === "function";
}

/** Validates the `actions` export of the project entry point; absent means no actions. */
export function loadActionDefinitions(value: unknown): readonly ActionDefinition[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        throw new Error("The actions export of the project entry point must be an array of defineAction() results");
    }
    if (value.length > MAX_ACTIONS_PER_PROJECT) {
        throw new Error(`A project can declare at most ${MAX_ACTIONS_PER_PROJECT} actions`);
    }
    const keys = new Set<string>();
    return value.map((item, index) => {
        if (!isActionDefinition(item)) {
            throw new Error(`actions[${index}] is not a defineAction() result`);
        }
        if (keys.has(item.key)) throw new Error(`Action key '${item.key}' is exported more than once`);
        keys.add(item.key);
        return item;
    });
}

export function findAction(actions: readonly ActionDefinition[], key: string): ActionDefinition | undefined {
    return actions.find(action => action.key === key);
}

export function actionManifests(actions: readonly ActionDefinition[]): readonly ActionManifest[] {
    return actions.map(action => action.config);
}

export function isActionKey(value: string): boolean {
    return ACTION_KEY.test(value);
}

function idText(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > MAX_ID_LENGTH) {
        throw invalidRequest(`${label} must be a non-empty string of at most ${MAX_ID_LENGTH} characters`);
    }
    return value;
}

function optionalIdText(value: unknown, label: string): string | null {
    return value === null ? null : idText(value, label);
}

function parseSource(raw: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(raw)) throw invalidRequest("source must be an object whose type is \"process\" or \"agent\"");
    const allowed = raw.type === "process" ? PROCESS_SOURCE_KEYS : raw.type === "agent" ? AGENT_SOURCE_KEYS : null;
    if (allowed === null) throw invalidRequest("source.type must be \"process\" or \"agent\"");
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) throw invalidRequest(`source has an unknown property '${key}' for type ${raw.type}`);
    }
    for (const key of ["processId", "processInfoId", "instanceId", "nodeId", "agentId"]) {
        if (raw[key] !== undefined) idText(raw[key], `source.${key}`);
    }
    for (const key of ["sessionId", "runId", "initiatorPersonnelId"]) {
        if (raw[key] !== undefined) optionalIdText(raw[key], `source.${key}`);
    }
    if (raw.runAs !== undefined && raw.runAs !== null
        && (typeof raw.runAs !== "string" || !PROCESS_RUN_AS.has(raw.runAs))) {
        throw invalidRequest("source.runAs must be \"PROCESS_STARTER\", \"PERSONNEL\", \"SYSTEM\" or null");
    }
    if (raw.interactive !== undefined && typeof raw.interactive !== "boolean") {
        throw invalidRequest("source.interactive must be a boolean");
    }
    return {...raw};
}

/** Accepts `{input, source?, runId?}`; `input` is checked against the schema when the action runs. */
export function parseActionRunRequest(body: Record<string, unknown>): ActionRunRequest {
    for (const key of Object.keys(body)) {
        if (!REQUEST_KEYS.has(key)) throw invalidRequest(`Unknown property '${key}'`);
    }
    if (!hasOwn(body, "input")) throw invalidRequest("input is required: the action input as a JSON object");
    const request: {input: unknown; source?: Readonly<Record<string, unknown>>; runId?: string} = {input: body.input};
    if (body.source !== undefined) request.source = parseSource(body.source);
    if (body.runId !== undefined) request.runId = idText(body.runId, "runId");
    return request;
}

function buildSource(
    manifest: ActionManifest,
    raw: Readonly<Record<string, unknown>> | undefined,
    invocation: InvocationContext,
): ActionSource {
    const type = raw?.type ?? manifest.exposeTo[0];
    if (type === "process") {
        const source: ProcessActionSource = {
            type: "process",
            processId: typeof raw?.processId === "string" ? raw.processId : "local_process",
            processInfoId: typeof raw?.processInfoId === "string" ? raw.processInfoId : "local_process_info",
            instanceId: typeof raw?.instanceId === "string" ? raw.instanceId : "local_process_instance",
            nodeId: typeof raw?.nodeId === "string" ? raw.nodeId : "local_node",
            runAs: typeof raw?.runAs === "string" ? raw.runAs as ProcessActionRunAs : null,
        };
        return source;
    }
    const callerPersonnelId = invocation.user?.membership.personnelId ?? null;
    const source: AgentActionSource = {
        type: "agent",
        agentId: typeof raw?.agentId === "string" ? raw.agentId : "local_agent",
        sessionId: typeof raw?.sessionId === "string" ? raw.sessionId : null,
        runId: typeof raw?.runId === "string" ? raw.runId : null,
        interactive: typeof raw?.interactive === "boolean" ? raw.interactive : false,
        initiatorPersonnelId: raw !== undefined && hasOwn(raw, "initiatorPersonnelId")
            ? raw.initiatorPersonnelId as string | null
            : callerPersonnelId,
    };
    return source;
}

/* ------------------------------------------------------------------------------------------------
 * Schema validation. Mirrors the check Cogover applies to the input and the output of an action:
 * the JSON Schema subset that the SDK builder `s` produces, with the same JSON Pointer paths and
 * messages. A message never echoes a value.
 * ---------------------------------------------------------------------------------------------- */

export interface SchemaIssue {
    /** JSON Pointer of the value; `""` is the root. */
    readonly path: string;
    readonly message: string;
}

export interface SchemaValidation {
    /**
     * The value as it reaches the handler or the caller when there is no issue: an optional
     * property that is `null` is removed, like an absent one. `undefined` when there are issues.
     */
    readonly value: unknown;
    /** The first {@link MAX_REPORTED_ERRORS} issues. */
    readonly issues: readonly SchemaIssue[];
    readonly issueCount: number;
}

class IssueCollector {
    readonly issues: SchemaIssue[] = [];
    count = 0;

    add(path: string, message: string): void {
        this.count++;
        if (this.issues.length < MAX_REPORTED_ERRORS) this.issues.push({path, message});
    }
}

function schemaNumber(schema: JsonSchema, keyword: string): number | undefined {
    const value = schema[keyword];
    return typeof value === "number" ? value : undefined;
}

function isCalendarDate(text: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match === null) return false;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

function checkString(schema: JsonSchema, text: string, path: string, issues: IssueCollector): void {
    const values = schema.enum;
    if (Array.isArray(values)) {
        if (!values.includes(text)) issues.add(path, "must be one of the allowed values");
        return;
    }
    if (schema.format === "date") {
        if (!isCalendarDate(text)) issues.add(path, "must be a date in the format YYYY-MM-DD");
        return;
    }
    const length = [...text].length;
    if (schema["x-cogover-object"] !== undefined) {
        if (text.trim() === "" || length > MAX_RECORD_ID_CHARS) {
            issues.add(path, `must be a record ID of 1 to ${MAX_RECORD_ID_CHARS} characters`);
        }
        return;
    }
    const maxLength = schemaNumber(schema, "maxLength") ?? DEFAULT_MAX_LENGTH;
    const minLength = schemaNumber(schema, "minLength") ?? 0;
    if (length > maxLength) {
        issues.add(path, `must be at most ${maxLength} characters long`);
    } else if (length < minLength) {
        issues.add(path, `must be at least ${minLength} characters long`);
    }
}

function checkBounds(schema: JsonSchema, value: number, path: string, issues: IssueCollector): void {
    const minimum = schemaNumber(schema, "minimum");
    const maximum = schemaNumber(schema, "maximum");
    if (minimum !== undefined && value < minimum) {
        issues.add(path, `must be at least ${minimum}`);
    } else if (maximum !== undefined && value > maximum) {
        issues.add(path, `must be at most ${maximum}`);
    }
}

function checkObject(
    schema: JsonSchema,
    value: Record<string, unknown>,
    path: string,
    issues: IssueCollector,
): Record<string, unknown> {
    const properties = isRecord(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const name of Object.keys(value)) {
        if (!hasOwn(properties, name)) {
            // The property name is caller data: it is reported only when it has the shape of a name.
            issues.add(PROPERTY_NAME.test(name) ? `${path}/${name}` : path, "is not a property of this object");
        }
    }
    const normalized: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties)) {
        const item = hasOwn(value, name) ? value[name] : undefined;
        if (item === undefined || item === null) {
            if (required.has(name)) issues.add(`${path}/${name}`, "is required");
            continue;
        }
        const checked = checkValue(child, item, `${path}/${name}`, issues);
        if (checked !== null) normalized[name] = checked;
    }
    return normalized;
}

function checkValue(schema: JsonSchema, value: unknown, path: string, issues: IssueCollector): unknown {
    if (value === null || value === undefined) {
        issues.add(path, "must not be null");
        return null;
    }
    switch (schema.type) {
        case "string":
            if (typeof value !== "string") {
                issues.add(path, "must be a string");
                return null;
            }
            checkString(schema, value, path, issues);
            return value;
        case "number":
            if (typeof value !== "number" || !Number.isFinite(value)) {
                issues.add(path, "must be a number");
                return null;
            }
            checkBounds(schema, value, path, issues);
            return value;
        case "integer":
            if (typeof value !== "number" || !Number.isSafeInteger(value)) {
                issues.add(path, schema.format === "x-epoch-ms"
                    ? "must be a timestamp in epoch milliseconds" : "must be an integer");
                return null;
            }
            checkBounds(schema, value, path, issues);
            return value;
        case "boolean":
            if (typeof value !== "boolean") {
                issues.add(path, "must be a boolean");
                return null;
            }
            return value;
        case "array": {
            if (!Array.isArray(value)) {
                issues.add(path, "must be an array");
                return null;
            }
            const maxItems = schemaNumber(schema, "maxItems") ?? DEFAULT_MAX_ITEMS;
            if (value.length > maxItems) {
                issues.add(path, `must contain at most ${maxItems} items`);
                return null;
            }
            const items = isRecord(schema.items) ? schema.items as JsonSchema : {};
            return value.map((item, index) => checkValue(items, item, `${path}/${index}`, issues));
        }
        case "object":
            if (!isRecord(value)) {
                issues.add(path, "must be an object");
                return null;
            }
            return checkObject(schema, value, path, issues);
        default:
            issues.add(path, "has an unsupported schema");
            return null;
    }
}

/** Checks a value against an action input or output schema, as Cogover does. */
export function validateActionValue(schema: JsonSchema, value: unknown): SchemaValidation {
    const issues = new IssueCollector();
    const normalized = checkValue(schema, value, "", issues);
    return {
        value: issues.issues.length === 0 ? normalized : undefined,
        issues: issues.issues,
        issueCount: issues.count,
    };
}

function validationDetails(validation: SchemaValidation): Record<string, unknown> {
    const details: Record<string, unknown> = {errors: validation.issues};
    if (validation.issueCount > validation.issues.length) details.errorCount = validation.issueCount;
    return details;
}

/* ------------------------------------------------------------------------------------------------
 * Running the handler.
 * ---------------------------------------------------------------------------------------------- */

const TIMED_OUT: unique symbol = Symbol("action timed out");

/** The output member of the handler's answer, or `undefined` for a value that is not JSON data. */
function handlerOutput(resultJson: string): unknown {
    let parsed: unknown;
    try {
        parsed = JSON.parse(resultJson);
    } catch {
        return undefined;
    }
    return isRecord(parsed) && hasOwn(parsed, "output") ? parsed.output : undefined;
}

function staticWarnings(manifest: ActionManifest, source: ActionSource, warnings: string[]): void {
    if (manifest.effect === "read") {
        warnings.push("This action is declared read-only: in Cogover every write and other side effect it attempts "
            + "(records, state, locks, push, notifications, email, jobs, secrets, processes.start, agents.start) "
            + "is refused with PermissionDeniedError, but a local Development Session does not enforce this. "
            + "Start cogover-dev run with --allow-writes=false to catch writes.");
    }
    if (source.type === "process" && source.runAs === "SYSTEM") {
        warnings.push("With runAs SYSTEM, Cogover runs this call without a user (invocation.identity \"system\"), "
            + "which the identity policy must allow with allowInternalSystem; locally it runs as the "
            + "Development Session caller.");
    }
}

/**
 * Checks the input, runs the handler once with the same metadata Cogover sends, and checks
 * the output. The result has the status, output and error the calling Process node or AI
 * Agent would receive.
 */
export async function runActionLocally(options: ActionRunOptions): Promise<ActionRunResult> {
    const manifest = options.definition.config;
    const {invocation} = options;
    const requestedType = options.request.source?.type;
    if (typeof requestedType === "string" && !manifest.exposeTo.includes(requestedType as ActionSource["type"])) {
        throw new ActionRunError(403, "ACTION_NOT_EXPOSED",
            `Action '${manifest.key}' is not exposed to ${requestedType}; it declares exposeTo ${manifest.exposeTo.join(", ")}`);
    }
    const source = buildSource(manifest, options.request.source, invocation);
    const runId = options.request.runId ?? randomUUID();
    const warnings: string[] = [];
    staticWarnings(manifest, source, warnings);
    const started = performance.now();
    const finish = (
        input: unknown,
        status: ActionCallStatus,
        output: unknown,
        error: ActionCallError | null,
    ): ActionRunResult => ({
        action: {key: manifest.key, effect: manifest.effect, runId, source},
        input,
        status,
        output,
        error,
        durationMs: Math.round(performance.now() - started),
        warnings,
    });

    const input = validateActionValue(manifest.inputSchema, options.request.input);
    if (input.issues.length > 0) {
        return finish(null, "FAILED", null, {
            code: "INPUT_INVALID",
            message: "The action input does not match its schema",
            details: validationDetails(input),
        });
    }

    const sandboxInput = {
        input: input.value,
        __context: {
            projectSlug: options.projectSlug,
            workspaceId: invocation.workspace.id,
            workspace: invocation.workspace,
            source: "action",
            executionIdentity: invocation.identity,
            user: invocation.user,
            action: {key: manifest.key, runId, effect: manifest.effect},
            actionSource: source,
        },
    };
    const running = Promise.resolve().then(() => options.definition.__cogoverActionHandler(JSON.stringify(sandboxInput)));
    // After a timeout the handler keeps running locally; its late failure must not become an unhandled rejection.
    running.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(TIMED_OUT), manifest.timeoutMs);
    });
    let resultJson: string | typeof TIMED_OUT;
    try {
        resultJson = await Promise.race([running, timeout]);
    } catch (error) {
        return finish(input.value, "FAILED", null, options.describeHandlerError(error));
    } finally {
        clearTimeout(timer);
    }
    if (resultJson === TIMED_OUT) {
        warnings.push("Cogover stops the handler at the time limit; locally it may still be running.");
        return finish(input.value, "FAILED", null, {
            code: "TIMEOUT",
            message: "The action exceeded its time limit",
            details: {timeoutMs: manifest.timeoutMs},
        });
    }

    const output = handlerOutput(resultJson);
    if (output === undefined) {
        return finish(input.value, "FAILED", null, {
            code: "OUTPUT_INVALID",
            message: "The action returned a value that is not JSON data",
            details: null,
        });
    }
    const checked = validateActionValue(manifest.outputSchema, output);
    if (checked.issues.length > 0) {
        return finish(input.value, "FAILED", null, {
            code: "OUTPUT_INVALID",
            message: "The action output does not match its schema",
            details: validationDetails(checked),
        });
    }
    return finish(input.value, "COMPLETED", checked.value, null);
}
