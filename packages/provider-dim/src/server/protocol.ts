/** Dim App Server protocol v4: NDJSON JSON-RPC 2.0 over a unix socket or named pipe. */
export const DIM_PROTOCOL_VERSION = 4;
/** The server refuses frames above 16 MiB; a client line budget matches it. */
export const DIM_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const DIM_BRANCH = "main";
export const DIM_DEFAULT_MODEL_SLUG = "default";
/** A transcript value any actual value matches, for ids and paths that differ per run. */
export const DIM_REPLAY_ANY = "<any>";

/** Features the adapter needs before it can host a thread. */
export const DIM_REQUIRED_FEATURES = [
  "session.create",
  "session.submit",
  "session.stop",
  "session.history",
  "session.model.progress",
  "session.branch.get",
  "session.input_lookup",
] as const;

export interface DimHelloResult {
  readonly instanceId: string;
  readonly serverVersion: string;
  readonly buildId?: string;
  readonly protocolVersion: number;
  readonly daemonProfile: { readonly kind: "mock" | "configured" | "product" };
  readonly features?: ReadonlyArray<string>;
}

export interface DimNotice {
  readonly method: string;
  readonly params: unknown;
}

export interface DimSessionEvent {
  readonly sessionId: string;
  readonly branchId: string;
  readonly event: {
    readonly id: string;
    readonly sequence: number;
    readonly create_at: number;
    readonly type: string;
    readonly name: string;
    readonly data: unknown;
  };
}

export interface DimStateNotice {
  readonly sessionId: string;
  readonly branchId: string;
  readonly running: boolean;
  readonly stopping: boolean;
}

export interface DimModelProgressNotice {
  readonly sessionId: string;
  readonly branchId: string;
  readonly turnId: string | null;
  readonly requestId: string | null;
  readonly text: string;
  readonly textOffset: number;
  readonly thinking: string;
  readonly thinkingOffset: number;
  readonly tools: ReadonlyArray<unknown>;
}

export interface DimApprovalRequestNotice {
  readonly sessionId: string;
  readonly branchId: string;
  readonly requestId: string;
  readonly source: unknown;
  readonly call: { readonly name: string; readonly input: Record<string, unknown> };
  readonly reason: string;
}

export interface DimApprovalCancelledNotice {
  readonly sessionId: string;
  readonly branchId: string;
  readonly requestId: string;
  readonly reason: string;
}

export interface DimClosedNotice {
  readonly sessionId: string;
  readonly reason?: string;
}

export interface DimAttachResult {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly createdAt: number;
  readonly running: boolean;
  readonly sequence: number;
  readonly attachedClients: number;
  readonly title?: string | null;
  readonly capabilitySnapshot?: unknown;
}

export interface DimCreateResult {
  readonly sessionId: string;
  readonly model: { readonly providerId: string; readonly modelId: string };
  readonly sequence: number;
}

export interface DimHistoryResult {
  readonly events: ReadonlyArray<DimSessionEvent["event"]>;
  readonly through: number;
  readonly nextAfter: number;
  readonly done: boolean;
}

export interface DimBranchResult {
  readonly head: number;
  readonly state: string;
}

export interface DimRpcErrorData {
  readonly appError?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function recordString(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
}

export function recordNumber(value: unknown, key: string): number | undefined {
  const field = recordField(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function recordArray(value: unknown, key: string): ReadonlyArray<unknown> | undefined {
  const field = recordField(value, key);
  return Array.isArray(field) ? field : undefined;
}

/** `providerId/modelId`, split at the first slash so model ids may hold their own. */
export function parseDimModelSlug(slug: string): { providerId: string; modelId: string } | null {
  const trimmed = slug.trim();
  if (trimmed === "" || trimmed === DIM_DEFAULT_MODEL_SLUG) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function formatDimModelSlug(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** One branch fact from a `session.event` notice or a `session.history` page. */
export function parseDimEvent(event: unknown): DimSessionEvent["event"] | null {
  if (!isRecord(event)) return null;
  const id = recordString(event, "id");
  const type = recordString(event, "type");
  const name = recordString(event, "name");
  const sequence = recordNumber(event, "sequence");
  const createAt = recordNumber(event, "create_at");
  if (id === undefined || type === undefined || name === undefined) return null;
  if (sequence === undefined || createAt === undefined) return null;
  return { id, sequence, create_at: createAt, type, name, data: event["data"] };
}

export function dimEvent(data: unknown): DimSessionEvent | null {
  const sessionId = recordString(data, "sessionId");
  const branchId = recordString(data, "branchId");
  const event = parseDimEvent(recordField(data, "event"));
  if (sessionId === undefined || branchId === undefined || event === null) return null;
  return { sessionId, branchId, event };
}

export function dimState(data: unknown): DimStateNotice | null {
  const sessionId = recordString(data, "sessionId");
  const branchId = recordString(data, "branchId");
  const running = recordField(data, "running");
  const stopping = recordField(data, "stopping");
  if (sessionId === undefined || branchId === undefined) return null;
  if (typeof running !== "boolean" || typeof stopping !== "boolean") return null;
  return { sessionId, branchId, running, stopping };
}

export function dimProgress(data: unknown): DimModelProgressNotice | null {
  const sessionId = recordString(data, "sessionId");
  const branchId = recordString(data, "branchId");
  const text = recordField(data, "text");
  const thinking = recordField(data, "thinking");
  if (sessionId === undefined || branchId === undefined) return null;
  if (typeof text !== "string" || typeof thinking !== "string") return null;
  return {
    sessionId,
    branchId,
    turnId: recordString(data, "turnId") ?? null,
    requestId: recordString(data, "requestId") ?? null,
    text,
    textOffset: recordNumber(data, "textOffset") ?? 0,
    thinking,
    thinkingOffset: recordNumber(data, "thinkingOffset") ?? 0,
    tools: recordArray(data, "tools") ?? [],
  };
}

export function dimApprovalRequest(data: unknown): DimApprovalRequestNotice | null {
  const sessionId = recordString(data, "sessionId");
  const branchId = recordString(data, "branchId");
  const requestId = recordString(data, "requestId");
  const call = recordField(data, "call");
  if (sessionId === undefined || branchId === undefined || requestId === undefined) return null;
  if (!isRecord(call)) return null;
  const name = recordString(call, "name");
  const input = recordField(call, "input");
  if (name === undefined) return null;
  return {
    sessionId,
    branchId,
    requestId,
    source: recordField(data, "source"),
    call: { name, input: isRecord(input) ? input : {} },
    reason: recordString(data, "reason") ?? "",
  };
}

export function dimApprovalCancelled(data: unknown): DimApprovalCancelledNotice | null {
  const sessionId = recordString(data, "sessionId");
  const branchId = recordString(data, "branchId");
  const requestId = recordString(data, "requestId");
  if (sessionId === undefined || branchId === undefined || requestId === undefined) return null;
  return { sessionId, branchId, requestId, reason: recordString(data, "reason") ?? "" };
}

export function dimClosed(data: unknown): DimClosedNotice | null {
  const sessionId = recordString(data, "sessionId");
  if (sessionId === undefined) return null;
  const reason = recordString(data, "reason");
  return { sessionId, ...(reason === undefined ? {} : { reason }) };
}

export function userTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!isRecord(block) || block["type"] !== "text") return [];
      const text = block["text"];
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}
