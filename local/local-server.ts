import {readFile} from "node:fs/promises";
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import {resolve} from "node:path";
import {CogoverApiError, type InvocationContext, type SandboxHandler, type TriggerDefinition} from "@cogover/sdk";
import {
    bridgeRecordReader,
    findTrigger,
    parseTriggerRunRequest,
    runTriggerLocally,
    triggerManifests,
    TriggerRunError,
    type RecordReader,
} from "./trigger-runner.js";

const URI_PREFIX = "/api/v1/ts-projects/";
/** Local-only tooling namespace; it never exists on Cogover Runtime Server. */
const LOCAL_TOOLING_PREFIX = "/__cogover";
const TRIGGERS_PATH = `${LOCAL_TOOLING_PREFIX}/triggers`;
const TRIGGER_KEY = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const MAX_INPUT_BYTES = 256 * 1024;
const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const REQUEST_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const HIDDEN_REQUEST_HEADERS = new Set([
    "authorization", "cookie", "proxy-authorization", "host", "content-length", "connection",
    "transfer-encoding", "upgrade", "x-csrf-token", "x-xsrf-token", "x-api-key", "api-key",
]);
const DEVELOPMENT_INVOCATION_OPERATION = "development.invocation.get";

const SCRIPT_ERRORS: Readonly<Record<string, {status: number; message: string}>> = {
    DEVELOPMENT_SESSION_INVALIDATED: {
        status: 401,
        message: "The Development session is no longer valid. Restart cogover-dev run.",
    },
    PERMISSION_DENIED: {status: 403, message: "You do not have permission to perform this operation."},
    NOT_FOUND: {status: 404, message: "The requested record, object, or route was not found."},
    METHOD_NOT_ALLOWED: {status: 405, message: "The HTTP method is not supported."},
    VALIDATION_ERROR: {status: 400, message: "The input or operation parameters are invalid."},
    STATE_CONFLICT: {status: 409, message: "Project state was changed by another execution."},
    LOCK_NOT_ACQUIRED: {status: 409, message: "The distributed lock could not be acquired."},
    LOCK_LOST: {status: 409, message: "The distributed lock lease is no longer owned."},
    STATE_SERVICE_UNAVAILABLE: {status: 503, message: "Project state is temporarily unavailable."},
    LOCK_SERVICE_UNAVAILABLE: {status: 503, message: "Distributed locking is temporarily unavailable."},
    RATE_LIMITED: {status: 429, message: "The request limit has been exceeded. Please try again later."},
    FETCH_DISABLED: {status: 503, message: "Outbound HTTP requests are temporarily unavailable."},
    FETCH_BLOCKED: {status: 400, message: "The outbound HTTP request is not allowed."},
    FETCH_REQUEST_TOO_LARGE: {status: 413, message: "The outbound HTTP request is too large."},
    FETCH_RESPONSE_TOO_LARGE: {status: 502, message: "The remote HTTP response exceeded the allowed limit."},
    FETCH_TIMEOUT: {status: 504, message: "The remote HTTP request timed out."},
    FETCH_FAILED: {status: 502, message: "The remote HTTP request could not be completed."},
    COGOVER_API_ERROR: {status: 422, message: "The data operation could not be completed."},
};

interface ProjectConfig {
    projectSlug?: unknown;
}

interface CachedResponse {
    status: number;
    headers?: Readonly<Record<string, string | readonly string[]>>;
    body: string | Uint8Array;
}

export interface LocalServerOptions {
    /** Default export of the project entry point; optional when the project only has triggers. */
    handler?: SandboxHandler;
    /** `triggers` export of the project entry point, served at `POST /__cogover/triggers/<key>`. */
    triggers?: readonly TriggerDefinition[];
    projectSlug?: string;
    configPath?: string;
    host?: string;
    port?: number;
    /** Explicit test hook. Production loads the public snapshot from the active Development Session. */
    invocation?: InvocationContext;
    /** Explicit test hook. Production reads records through the active Development Session. */
    readRecord?: RecordReader;
    /** Test harness hook; production CLI leaves the server running until interrupted. */
    maxRequests?: number;
    /** Test hook for observing unexpected script failures without replacing process.stderr. */
    onUnexpectedScriptError?: (error: unknown) => void;
}

export interface StartedLocalServer {
    server: Server;
    host: string;
    port: number;
    projectSlug: string;
    url: string;
    close(): Promise<void>;
}

function jsonResponse(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string | readonly string[]>> = {},
): void {
    const normalizedHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        normalizedHeaders[name] = typeof value === "string" ? value : [...value];
    }
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...normalizedHeaders,
    });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
}

function httpResponse(response: ServerResponse, rendered: CachedResponse): void {
    const headers: Record<string, string | string[]> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    };
    for (const [name, value] of Object.entries(rendered.headers ?? {})) {
        headers[name] = typeof value === "string" ? value : [...value];
    }
    response.writeHead(rendered.status, headers);
    response.end(rendered.body);
}

function errorResponse(status: number, message: string): CachedResponse {
    return {status, body: JSON.stringify({r: status, msg: message})};
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

const IDENTITY_DENIAL_SOURCES = ["PROJECT_POLICY", "PROJECT_KEY", "RUNTIME_CONFIGURATION"] as const;
type IdentityDenialSource = typeof IDENTITY_DENIAL_SOURCES[number];

function identityDenialSources(details: Record<string, unknown>): IdentityDenialSource[] {
    const values = Array.isArray(details.deniedBy) ? details.deniedBy : [];
    const sources = IDENTITY_DENIAL_SOURCES.filter(source => values.includes(source));
    return sources.length > 0 ? sources : ["PROJECT_POLICY"];
}

function denialSourceText(sources: readonly IdentityDenialSource[]): string {
    const labels = sources.map(source => source === "PROJECT_POLICY" ? "the Project policy"
        : source === "PROJECT_KEY" ? "this Project key" : "Runtime Server configuration");
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function permissionMessage(details: Record<string, unknown>): string | undefined {
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    if (reason === "PROJECT_KEY_WRITE_NOT_ALLOWED") {
        return "This Project key does not allow write operations";
    }
    if (reason === "DEVELOPMENT_SESSION_READ_ONLY") {
        return "This Development session is read-only";
    }
    if (reason === "DEVELOPMENT_WRITES_DISABLED") {
        return "Write operations are disabled for Development sessions";
    }

    const api = details.api === "data" || details.api === "data.asSystem" || details.api === "data.asUser"
        ? details.api : undefined;
    const operation = typeof details.operation === "string" ? details.operation : undefined;
    const objectSlug = typeof details.objectSlug === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(details.objectSlug)
        ? details.objectSlug : undefined;
    const personnelId = typeof details.personnelId === "string"
        && /^[A-Za-z0-9_-]{1,128}$/.test(details.personnelId) ? details.personnelId : undefined;
    if (!api) return undefined;

    const apiExpression = api === "data.asSystem" ? "data.asSystem()"
        : api === "data.asUser" ? (personnelId ? `data.asUser('${personnelId}')` : "data.asUser()")
            : "data";
    const call = operation ? `${apiExpression}${objectSlug ? `.object('${objectSlug}')` : ""}.${operation}` : undefined;
    if (reason === "IDENTITY_NOT_GRANTED") {
        const identityApi = api === "data.asSystem" ? "data.asSystem()"
            : api === "data.asUser" ? "data.asUser()" : "the requested identity";
        const identityTarget = api === "data.asUser" && personnelId
            ? `${identityApi} for personnel '${personnelId}'` : identityApi;
        const deniedBy = identityDenialSources(details);
        if (deniedBy.length > 1) {
            return `Access to ${identityTarget} was denied by ${denialSourceText(deniedBy)}.`;
        }
        if (deniedBy[0] === "PROJECT_KEY") return `This Project key does not allow ${identityApi}.`;
        if (deniedBy[0] === "RUNTIME_CONFIGURATION") {
            return `Runtime Server configuration does not allow ${identityApi}.`;
        }
        return `The Project policy does not allow ${identityTarget}.`;
    }
    if (reason === "OBJECT_NOT_GRANTED") {
        return objectSlug
            ? `This project has not been granted permission to access object '${objectSlug}' through ${apiExpression}.`
            : "This project has not been granted permission to perform the requested data operation.";
    }
    if (reason === "OPERATION_NOT_GRANTED") {
        return call ? `This project has not been granted permission to call ${call}.`
            : "This project has not been granted permission to perform the requested data operation.";
    }
    if (reason === "FIELD_NOT_GRANTED") {
        return call ? `This project has not been granted permission to access one or more requested fields through ${call}.`
            : "This project has not been granted permission to access one or more requested fields.";
    }
    if (reason === "OBJECT_SERVER_PERMISSION_DENIED") {
        if (api === "data.asUser" && personnelId) return call
            ? `Personnel '${personnelId}' does not have permission to call ${call}.`
            : `Personnel '${personnelId}' does not have permission to perform the requested data operation.`;
        if (api === "data") return call ? `The caller does not have permission to call ${call}.`
            : "The caller does not have permission to perform the requested data operation.";
        return call ? `The Object Server denied permission to call ${call}.`
            : "The Object Server denied permission to perform the requested system data operation.";
    }
    return undefined;
}

function developmentSessionMessage(details: Record<string, unknown>): string | undefined {
    if (details.reason === "PROJECT_KEY_PERMISSIONS_CHANGED") {
        return "The Development session was invalidated because the Project key permissions changed. Restart cogover-dev run.";
    }
    if (details.reason === "PROJECT_KEY_CHANGED") {
        return "The Development session was invalidated because the Project key changed. Restart cogover-dev run.";
    }
    if (details.reason === "PROJECT_POLICY_CHANGED") {
        return "The Development session was invalidated because the Project policy changed. Restart cogover-dev run.";
    }
    if (details.reason === "PROJECT_DISABLED") {
        return "The Development session was invalidated because the project is disabled.";
    }
    return undefined;
}

function notFoundMessage(details: Record<string, unknown>): string | undefined {
    if (details.reason !== "SELECTED_PERSONNEL_NOT_FOUND" || details.resource !== "personnel"
        || details.api !== "data.asUser") {
        return undefined;
    }
    const personnelId = typeof details.personnelId === "string"
        && /^[A-Za-z0-9_-]{1,128}$/.test(details.personnelId) ? details.personnelId : undefined;
    const resourceId = typeof details.resourceId === "string"
        && /^[A-Za-z0-9_-]{1,128}$/.test(details.resourceId) ? details.resourceId : undefined;
    return personnelId && resourceId === personnelId
        ? "The selected personnel identity could not be resolved."
        : undefined;
}

function validationMessage(details: Record<string, unknown>): string | undefined {
    const operation = typeof details.operation === "string"
        && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(details.operation) ? details.operation : undefined;
    const objectSlug = typeof details.objectSlug === "string"
        && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(details.objectSlug) ? details.objectSlug : undefined;
    const fieldSlug = typeof details.fieldSlug === "string"
        && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(details.fieldSlug) ? details.fieldSlug : undefined;
    if (!operation || !objectSlug || !fieldSlug) return undefined;
    if (details.reason === "UNKNOWN_FIELD") {
        return `Unknown field '${fieldSlug}' on object '${objectSlug}'.`;
    }
    if (details.reason === "FIELD_NOT_WRITABLE") {
        return `Field '${fieldSlug}' on object '${objectSlug}' is read-only.`;
    }
    if (details.reason === "FIELD_NOT_CREATABLE") {
        return `Field '${fieldSlug}' on object '${objectSlug}' cannot be set when creating a record.`;
    }
    if (details.reason === "UNIQUE_KEY_VIOLATION") {
        return `A record already exists with the same value for unique field '${fieldSlug}' on object '${objectSlug}'.`;
    }
    return undefined;
}

function scriptError(error: unknown): CachedResponse {
    if (!(error instanceof CogoverApiError)) {
        return errorResponse(422, "Script execution failed or exceeded its limits; writes may already have completed");
    }
    const details = isRecord(error.details) ? error.details : {};
    const known = SCRIPT_ERRORS[error.code];
    const detailsStatus = details.httpStatus;
    const status = known?.status ?? (typeof detailsStatus === "number"
        && Number.isInteger(detailsStatus) && detailsStatus >= 400 && detailsStatus <= 599
        ? detailsStatus : 422);
    const defaultMessage = known?.message ?? error.message;
    const writesMayHaveCompleted = details.writesMayHaveCompleted === true;
    const message = error.code === "PERMISSION_DENIED"
        ? permissionMessage(details) ?? defaultMessage
        : error.code === "DEVELOPMENT_SESSION_INVALIDATED"
            ? developmentSessionMessage(details) ?? defaultMessage
            : error.code === "NOT_FOUND"
                ? notFoundMessage(details) ?? defaultMessage
                : error.code === "VALIDATION_ERROR" ? validationMessage(details) ?? defaultMessage : defaultMessage;
    const body: Record<string, unknown> = {
        r: status,
        code: error.code,
        msg: message,
        writesMayHaveCompleted,
    };
    if (error.r !== undefined) body.objectServerR = error.r;
    if (error.code === "PERMISSION_DENIED" || error.code === "DEVELOPMENT_SESSION_INVALIDATED") {
        for (const field of ["reason", "api", "operation", "objectSlug", "personnelId"] as const) {
            const value = details[field];
            if (typeof value === "string") body[field] = value;
        }
        if (details.reason === "IDENTITY_NOT_GRANTED") {
            body.deniedBy = identityDenialSources(details);
        }
    }
    if (error.code === "NOT_FOUND" && notFoundMessage(details)) {
        for (const field of ["reason", "resource", "resourceId", "api", "operation", "objectSlug", "personnelId"] as const) {
            const value = details[field];
            if (typeof value === "string") body[field] = value;
        }
    }
    if (error.code === "VALIDATION_ERROR" && validationMessage(details)) {
        for (const field of ["reason", "operation", "objectSlug", "fieldSlug"] as const) {
            const value = details[field];
            if (typeof value === "string") body[field] = value;
        }
    }
    return status === 405
        ? {status, headers: {Allow: "GET, POST, PUT, PATCH, DELETE"}, body: JSON.stringify(body)}
        : {status, body: JSON.stringify(body)};
}

function unexpectedScriptErrorText(error: unknown): string {
    try {
        if (error instanceof Error) {
            const stack = error.stack?.trim();
            return stack || `${error.name}: ${error.message}`;
        }
        return String(error);
    } catch {
        // Error objects can define hostile getters; diagnostics must not break the HTTP response.
        return "Unknown thrown value";
    }
}

function reportUnexpectedScriptError(error: unknown): void {
    process.stderr.write(`[cogover-dev run] Unhandled script error\n${unexpectedScriptErrorText(error)}\n`);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_INPUT_BYTES) {
        request.resume();
        throw Object.assign(new Error("Script input is too large"), {httpStatus: 413});
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_INPUT_BYTES) {
            throw Object.assign(new Error("Script input is too large"), {httpStatus: 413});
        }
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw Object.assign(new Error("Request body must be one JSON object"), {httpStatus: 400});
    }
    if (!isRecord(value)) {
        throw Object.assign(new Error("Request body must be one JSON object"), {httpStatus: 400});
    }
    return value;
}

function parseInvocationPath(url: string | undefined, projectSlug: string): string | null {
    if (!url) return null;
    let pathname: string;
    try {
        pathname = new URL(url, "http://localhost").pathname;
    } catch {
        return null;
    }
    const project = `${URI_PREFIX}${projectSlug}`;
    if (pathname === project) return "/";
    if (!pathname.startsWith(`${project}/`)) return null;
    const route = pathname.slice(project.length);
    if (route.length > 4096 || route.endsWith("/") || route.includes("\\")) return null;
    for (const segment of route.slice(1).split("/")) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(segment);
        } catch {
            return null;
        }
        if (segment.length === 0 || segment.length > 1024 || decoded === "." || decoded === ".."
            || decoded.includes("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) {
            return null;
        }
    }
    return route;
}

function invocationQuery(url: string | undefined): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    if (!url) return result;
    const query = new URL(url, "http://localhost").searchParams;
    for (const name of new Set(query.keys())) {
        const values = query.getAll(name);
        if (values.length === 1) result[name] = values[0]!;
        else if (values.length > 1) result[name] = values;
    }
    return result;
}

function invocationHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, raw] of Object.entries(headers)) {
        const normalized = name.toLowerCase();
        if (raw === undefined || HIDDEN_REQUEST_HEADERS.has(normalized)
            || normalized.startsWith("x-req-") || normalized.startsWith("x-stringee-")) {
            continue;
        }
        const value = Array.isArray(raw) ? raw.join(", ") : raw;
        if (value.length <= 8192) result[normalized] = value;
    }
    return result;
}

function renderScriptResult(result: string | null): CachedResponse {
    const body = result ?? "null";
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return {status: 200, headers: {"Content-Type": "application/json; charset=utf-8"}, body};
    }
    if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !isRecord(parsed.__cogoverHttpResponse)) {
        return {status: 200, headers: {"Content-Type": "application/json; charset=utf-8"}, body};
    }
    const envelope = parsed.__cogoverHttpResponse;
    const status = typeof envelope.status === "number" ? envelope.status : 500;
    const headers: Record<string, string[]> = {};
    if (isRecord(envelope.headers)) {
        for (const [name, value] of Object.entries(envelope.headers)) {
            if (Array.isArray(value) && value.every(item => typeof item === "string")) {
                headers[name] = value;
            }
        }
    }
    switch (envelope.bodyType) {
        case "json":
            return {status, headers, body: JSON.stringify(envelope.body)};
        case "text":
            return {status, headers, body: typeof envelope.body === "string" ? envelope.body : ""};
        case "bytes":
            return {status, headers, body: Buffer.from(typeof envelope.body === "string" ? envelope.body : "", "base64")};
        case "empty":
            return {status, headers, body: ""};
        default:
            return {status: 500, headers: {"Content-Type": ["application/json; charset=utf-8"]},
                body: JSON.stringify({r: 500, msg: "Script returned an invalid HTTP response"})};
    }
}

type LocalToolingRoute = {kind: "triggers"} | {kind: "trigger"; key: string} | {kind: "unknown"};

function parseLocalToolingPath(url: string | undefined): LocalToolingRoute | null {
    if (!url) return null;
    let pathname: string;
    try {
        pathname = new URL(url, "http://localhost").pathname;
    } catch {
        return null;
    }
    if (pathname !== LOCAL_TOOLING_PREFIX && !pathname.startsWith(`${LOCAL_TOOLING_PREFIX}/`)) return null;
    if (pathname === TRIGGERS_PATH) return {kind: "triggers"};
    if (pathname.startsWith(`${TRIGGERS_PATH}/`)) {
        const key = pathname.slice(TRIGGERS_PATH.length + 1);
        if (TRIGGER_KEY.test(key)) return {kind: "trigger", key};
    }
    return {kind: "unknown"};
}

function hasNonJsonBody(request: IncomingMessage): boolean {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    const hasBody = (Number.isFinite(declaredLength) && declaredLength > 0)
        || request.headers["transfer-encoding"] !== undefined;
    return hasBody && contentType !== "application/json";
}

function failureResponse(error: unknown, report: (error: unknown) => void): CachedResponse {
    if (error instanceof TriggerRunError) {
        return {
            status: error.httpStatus,
            body: JSON.stringify({r: error.httpStatus, code: error.code, msg: error.message}),
        };
    }
    const httpStatus = isRecord(error) && typeof error.httpStatus === "number" ? error.httpStatus : undefined;
    const requestFailure = httpStatus === 400 || httpStatus === 413;
    if (!requestFailure && !(error instanceof CogoverApiError)) {
        try {
            report(error);
        } catch {
            // stderr reporting is best-effort and must not replace the original HTTP error.
        }
    }
    if (httpStatus === 413) return errorResponse(413, "Script input is too large");
    if (httpStatus === 400) return errorResponse(400, "Request body must be one JSON object");
    return scriptError(error);
}

async function loadProjectSlug(configPath: string): Promise<string> {
    let config: ProjectConfig;
    try {
        config = JSON.parse(await readFile(configPath, "utf8")) as ProjectConfig;
    } catch (error) {
        throw new Error(`Unable to read Cogover project config at ${configPath}`, {cause: error});
    }
    if (typeof config.projectSlug !== "string" || !PROJECT_SLUG.test(config.projectSlug)) {
        throw new Error("cogover.json must contain a valid projectSlug");
    }
    return config.projectSlug;
}

function validPort(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("Local HTTP port must be an integer from 0 to 65535");
    }
    return value;
}

async function loadDevelopmentInvocation(): Promise<InvocationContext> {
    const bridge = (globalThis as typeof globalThis & {
        __cogoverBridgeCall?: (requestJson: string) => Promise<string>;
    }).__cogoverBridgeCall;
    if (typeof bridge !== "function") {
        throw new Error("Development Session invocation metadata is unavailable. Start this server with cogover-dev run.");
    }
    let response: unknown;
    try {
        response = JSON.parse(await bridge(JSON.stringify({
            version: 1,
            operation: DEVELOPMENT_INVOCATION_OPERATION,
        }))) as unknown;
    } catch (error) {
        throw new Error("Unable to load invocation metadata from the active Development Session.", {cause: error});
    }
    if (!isRecord(response) || response.ok !== true || !isRecord(response.data)) {
        throw new Error("The active Development Session returned invalid invocation metadata.");
    }
    return response.data as unknown as InvocationContext;
}

export async function startLocalServer(options: LocalServerOptions): Promise<StartedLocalServer> {
    const host = options.host ?? "127.0.0.1";
    const port = validPort(options.port ?? 3000);
    const configPath = resolve(options.configPath ?? "cogover.json");
    const projectSlug = options.projectSlug ?? await loadProjectSlug(configPath);
    if (!PROJECT_SLUG.test(projectSlug)) throw new Error("Invalid project slug");
    const handler = options.handler;
    const triggers = options.triggers ?? [];
    if (handler === undefined && triggers.length === 0) {
        throw new Error("A project handler or at least one record trigger is required");
    }
    const readRecord = options.readRecord ?? bridgeRecordReader();
    const report = options.onUnexpectedScriptError ?? reportUnexpectedScriptError;
    const invocation = options.invocation ?? await loadDevelopmentInvocation();
    let remainingRequests = options.maxRequests;
    if (remainingRequests !== undefined && (!Number.isInteger(remainingRequests) || remainingRequests < 1)) {
        throw new Error("maxRequests must be a positive integer");
    }
    const countRequest = (): void => {
        if (remainingRequests !== undefined && --remainingRequests === 0) {
            setImmediate(() => server.close());
        }
    };

    const serveLocalTooling = async (
        request: IncomingMessage,
        response: ServerResponse,
        route: LocalToolingRoute,
    ): Promise<void> => {
        const requestMethod = request.method?.toUpperCase() ?? "";
        if (route.kind === "unknown") {
            jsonResponse(response, 404, {r: 404, msg: "Local tooling route not found"});
            return;
        }
        if (route.kind === "triggers") {
            if (requestMethod !== "GET") {
                jsonResponse(response, 405, {r: 405, msg: "Unsupported HTTP method"}, {Allow: "GET"});
                return;
            }
            jsonResponse(response, 200, {triggers: triggerManifests(triggers)});
            return;
        }
        if (requestMethod !== "POST") {
            jsonResponse(response, 405, {r: 405, msg: "Unsupported HTTP method"}, {Allow: "POST"});
            return;
        }
        if (hasNonJsonBody(request)) {
            jsonResponse(response, 415, {r: 415, msg: "Content-Type must be application/json"});
            return;
        }
        try {
            const body = await readBody(request);
            const definition = findTrigger(triggers, route.key);
            if (definition === undefined) {
                throw new TriggerRunError(404, "TRIGGER_NOT_FOUND",
                    `Trigger '${route.key}' is not exported by the project entry point`);
            }
            const result = await runTriggerLocally({
                definition,
                request: parseTriggerRunRequest(body),
                projectSlug,
                invocation,
                readRecord,
            });
            jsonResponse(response, 200, result);
        } catch (error) {
            const rendered = failureResponse(error, report);
            jsonResponse(response, rendered.status, rendered.body, rendered.headers);
        } finally {
            countRequest();
        }
    };

    const server = createServer(async (request, response) => {
        const tooling = parseLocalToolingPath(request.url);
        if (tooling !== null) {
            await serveLocalTooling(request, response, tooling);
            return;
        }
        const routePath = parseInvocationPath(request.url, projectSlug);
        if (routePath === null) {
            jsonResponse(response, 404, {r: 404, msg: "TypeScript project route not found"});
            return;
        }
        if (handler === undefined) {
            jsonResponse(response, 404, {r: 404, msg: "This project has no HTTP handler; it exports record triggers only"});
            return;
        }
        const requestMethod = request.method?.toUpperCase() ?? "";
        if (!REQUEST_METHODS.has(requestMethod)) {
            jsonResponse(response, 405, {r: 405, msg: "Unsupported HTTP method"},
                {Allow: "GET, POST, PUT, PATCH, DELETE"});
            return;
        }
        if (hasNonJsonBody(request)) {
            jsonResponse(response, 415, {r: 415, msg: "Content-Type must be application/json"});
            return;
        }
        try {
            const body = await readBody(request);
            // Host-owned metadata always overrides body fields, exactly as Runtime Server does.
            delete body.__context;
            const input = {
                ...body,
                __context: {
                    projectSlug,
                    workspaceId: invocation.workspace.id,
                    workspace: invocation.workspace,
                    request: {
                        method: requestMethod,
                        path: routePath,
                        query: invocationQuery(request.url),
                        headers: invocationHeaders(request.headers),
                    },
                    source: "http",
                    executionIdentity: invocation.identity,
                    user: invocation.user,
                },
            };
            const result = await handler(JSON.stringify(input));
            httpResponse(response, renderScriptResult(result));
        } catch (error) {
            const rendered = failureResponse(error, report);
            jsonResponse(response, rendered.status, rendered.body, rendered.headers);
        } finally {
            countRequest();
        }
    });

    await new Promise<void>((resolveListening, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
            server.off("error", onError);
            resolveListening();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local HTTP server did not expose a TCP address");
    const actualPort = address.port;
    const url = `http://${host}:${actualPort}${URI_PREFIX}${projectSlug}`;
    return {
        server,
        host,
        port: actualPort,
        projectSlug,
        url,
        close: () => new Promise<void>((resolveClose, reject) => {
            server.close(error => error ? reject(error) : resolveClose());
        }),
    };
}
