import type {
  MessageId,
  NodeId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderOptionDescriptor,
  ProviderRequestKind,
  ServerProviderModel,
  ThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

import {
  DIM_DEFAULT_MODEL_SLUG,
  formatDimModelSlug,
  isRecord,
  recordArray,
  recordField,
  recordNumber,
  recordString,
  userTextFromContent,
  type DimSessionEvent,
} from "./protocol.ts";

export function dimUserInput(data: unknown): { submissionId: string; text: string } | null {
  const submissionId = recordString(data, "submission_id");
  const user = recordField(data, "user");
  if (submissionId === undefined || !isRecord(user)) return null;
  const text = userTextFromContent(recordField(user, "content"));
  return text.trim() === "" ? null : { submissionId, text };
}

/** Runtime state blocks (`<dim-state …>`) arrive as input/message without a submission. */
export function dimStateBlocks(data: unknown): boolean {
  return (
    recordField(data, "submission_id") === undefined && recordArray(data, "blocks") !== undefined
  );
}

export function dimDelta(data: unknown): { requestId: string; delta: string } | null {
  const requestId = recordString(data, "request_id");
  const delta = recordString(data, "delta");
  return requestId === undefined || delta === undefined || delta === ""
    ? null
    : { requestId, delta };
}

export function dimToolUse(
  data: unknown,
): { callId: string; name: string; input: Record<string, unknown> } | null {
  const call = recordField(data, "call");
  if (!isRecord(call)) return null;
  const callId = recordString(call, "id");
  const name = recordString(call, "name");
  if (callId === undefined || name === undefined) return null;
  const input = recordField(call, "input");
  return { callId, name, input: isRecord(input) ? input : {} };
}

export function dimToolResults(
  data: unknown,
): ReadonlyArray<{ callId: string; content: string; isError: boolean; structured: unknown }> {
  const results = recordArray(data, "results") ?? [];
  return results.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const callId = recordString(entry, "call_id");
    const result = recordField(entry, "result");
    if (callId === undefined || !isRecord(result)) return [];
    const content = recordField(result, "content");
    return [
      {
        callId,
        content: typeof content === "string" ? content : "",
        isError: recordField(result, "isError") === true,
        structured: recordField(result, "structuredContent"),
      },
    ];
  });
}

export interface DimModelProgress {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly requestId: string | null;
  /** This request's text not yet published as `step/text`. */
  readonly text: string;
  /** Unicode scalars of published `step/text` deltas that precede `text`. */
  readonly textOffset: number;
  readonly thinking: string;
  readonly thinkingOffset: number;
}

export function dimModelProgress(params: unknown): DimModelProgress | null {
  const sessionId = recordString(params, "sessionId");
  if (sessionId === undefined) return null;
  return {
    sessionId,
    turnId: recordString(params, "turnId") ?? null,
    requestId: recordString(params, "requestId") ?? null,
    text: recordString(params, "text") ?? "",
    textOffset: recordNumber(params, "textOffset") ?? 0,
    thinking: recordString(params, "thinking") ?? "",
    thinkingOffset: recordNumber(params, "thinkingOffset") ?? 0,
  };
}

export function dimTurnEnd(data: unknown): {
  turnId: string;
  status: "completed" | "cancelled" | "failed";
  reason: string | null;
} | null {
  const turnId = recordString(data, "turn_id");
  const status = recordString(data, "status");
  if (turnId === undefined) return null;
  if (status !== "completed" && status !== "cancelled" && status !== "failed") return null;
  return {
    turnId,
    status,
    reason: recordString(data, "reason") ?? recordString(data, "error") ?? null,
  };
}

export function dimModelOutputEnd(data: unknown): {
  requestId: string;
  status: "completed" | "failed" | "cancelled";
  detail: string | null;
  failure: unknown;
} | null {
  const requestId = recordString(data, "request_id");
  const status = recordString(data, "status");
  if (requestId === undefined) return null;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return null;
  return {
    requestId,
    status,
    detail: recordString(data, "error") ?? recordString(data, "reason") ?? null,
    failure: recordField(data, "failure"),
  };
}

const FAILURE_CLASS: Record<string, OrchestrationV2ProviderFailure["class"]> = {
  rate_limited: "usage_limit",
  quota_exhausted: "usage_limit",
  auth_rejected: "permission_error",
  invalid_request: "validation_error",
  context_too_long: "validation_error",
  content_filtered: "validation_error",
  output_limit: "validation_error",
  not_found: "provider_error",
  server_error: "provider_error",
  network: "transport_error",
  malformed_response: "transport_error",
  unknown: "unknown",
};

export function dimProviderFailure(input: {
  readonly error: string | null;
  readonly failure?: unknown;
  readonly resetAt?: string | null;
}): OrchestrationV2ProviderFailure {
  const kind = recordString(input.failure, "kind");
  const reason = recordString(input.failure, "reason");
  const message = reason ?? input.error ?? "Dim turn failed";
  return {
    class: kind === undefined ? "provider_error" : (FAILURE_CLASS[kind] ?? "unknown"),
    message,
    code: kind ?? null,
    retryable: null,
    ...(input.resetAt == null ? {} : { resetAt: input.resetAt }),
  };
}

export type DimToolItemKind = "command_execution" | "file_change" | "dynamic_tool";

export function dimToolItemKind(name: string): DimToolItemKind {
  if (name === "exec" || name === "exec_stop") return "command_execution";
  if (name === "write" || name === "edit") return "file_change";
  return "dynamic_tool";
}

export function dimApprovalKind(name: string): ProviderRequestKind {
  if (name === "exec" || name === "exec_stop") return "command";
  if (name === "write" || name === "edit") return "file-change";
  if (name === "read" || name === "glob" || name === "grep") return "file-read";
  return "permission";
}

export function dimApprovalOptions(): ReadonlyArray<{
  decision: "accept" | "decline";
  label: string;
}> {
  return [
    { decision: "accept", label: "Allow" },
    { decision: "decline", label: "Deny" },
  ];
}

/** The reasoning efforts a Dim catalog model declares, with `default` meaning "clear the preference". */
export function dimEffortDescriptor(metadata: unknown): ProviderOptionDescriptor | undefined {
  const reasoning = recordField(metadata, "reasoning");
  if (!isRecord(reasoning) || reasoning["supported"] !== true) return undefined;
  const declared = (recordArray(reasoning, "effortOptions") ?? []).filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
  const efforts = [...new Set(declared)];
  if (recordField(reasoning, "off") !== undefined && !efforts.includes("none")) {
    efforts.push("none");
  }
  if (efforts.length === 0) return undefined;
  const current = recordString(reasoning, "effort");
  const chosen = current !== undefined && efforts.includes(current) ? current : "default";
  return {
    id: "effort",
    label: "Reasoning effort",
    type: "select",
    role: "reasoning",
    currentValue: chosen,
    options: [
      {
        id: "default",
        label: "Provider default",
        ...(chosen === "default" ? { isDefault: true } : {}),
      },
      ...efforts.map((effort) => ({
        id: effort,
        label: effort === "none" ? "None" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`,
        ...(chosen === effort ? { isDefault: true } : {}),
      })),
    ],
  };
}

export interface DimCatalogModel {
  readonly model: ServerProviderModel;
  readonly contextWindow?: number;
}

export function dimModelFromCatalog(input: {
  readonly providerId: string;
  readonly providerName: string;
  readonly model: unknown;
}): DimCatalogModel | undefined {
  const id = recordString(input.model, "id");
  const name = recordString(input.model, "name") ?? id;
  if (id === undefined || name === undefined) return undefined;
  if (recordString(input.model, "unavailableReason") !== undefined) return undefined;
  const capabilities = recordField(input.model, "capabilities");
  const contextWindow = recordNumber(capabilities, "contextWindow");
  const effort = dimEffortDescriptor(recordField(input.model, "metadata"));
  const optionDescriptors = effort === undefined ? [] : [effort];
  return {
    model: {
      slug: formatDimModelSlug(input.providerId, id),
      name,
      subProvider: input.providerName,
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors }),
    },
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

export function dimDefaultModel(): ServerProviderModel {
  return {
    slug: DIM_DEFAULT_MODEL_SLUG,
    name: "Dim default",
    isCustom: false,
    capabilities: createModelCapabilities({ optionDescriptors: [] }),
  };
}

export function dimModelsFromConfigFile(input: unknown): ReadonlyArray<DimCatalogModel> {
  const providers = recordArray(input, "providers") ?? [];
  return providers.flatMap((provider) => {
    if (!isRecord(provider)) return [];
    const providerId = recordString(provider, "id");
    if (providerId === undefined) return [];
    const models = recordArray(provider, "models") ?? [];
    return models.flatMap((model) => {
      if (!isRecord(model)) return [];
      const id = recordString(model, "id");
      const name = recordString(model, "name") ?? id;
      if (id === undefined || name === undefined) return [];
      const contextWindow = recordNumber(model, "contextWindow");
      return [
        {
          model: {
            slug: formatDimModelSlug(providerId, id),
            name,
            isCustom: false,
            capabilities: createModelCapabilities({ optionDescriptors: [] }),
          } satisfies ServerProviderModel,
          ...(contextWindow === undefined ? {} : { contextWindow }),
        },
      ];
    });
  });
}

export interface DimSnapshotIds {
  readonly message: (nativeItemId: string) => MessageId;
  readonly providerTurn: (nativeTurnId: string) => ProviderTurnId;
  readonly node: (nativeItemId: string) => NodeId;
}

export interface DimThreadSnapshotBuild {
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly reasoningMessageIds: ReadonlyArray<MessageId>;
}

interface TextAccumulator {
  readonly firstEventId: string;
  readonly sequence: number;
  readonly createdAt: DateTime.Utc;
  text: string;
}

function createdAtOf(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function conversationMessage(input: {
  readonly id: MessageId;
  readonly threadId: ThreadId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): OrchestrationV2ConversationMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.role,
    text: input.text,
    attachments: [],
    streaming: false,
    createdBy: input.role === "user" ? "user" : "agent",
    creationSource: "provider",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

/** Builds T3's messages and turns from a Dim branch history (`session.history` events). */
export function buildDimThreadSnapshot(input: {
  readonly events: ReadonlyArray<DimSessionEvent["event"]>;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly ids: DimSnapshotIds;
  readonly driver: ProviderDriverKind;
}): DimThreadSnapshotBuild {
  const ordered: Array<{
    readonly sequence: number;
    readonly rank: number;
    readonly message: OrchestrationV2ConversationMessage;
    readonly reasoning: boolean;
  }> = [];
  const assistant = new Map<string, TextAccumulator>();
  const reasoning = new Map<string, TextAccumulator>();
  const turns = new Map<
    string,
    { sequence: number; startedAt: DateTime.Utc; completedAt: DateTime.Utc | null; status: string }
  >();

  const accumulate = (target: Map<string, TextAccumulator>, event: DimSessionEvent["event"]) => {
    const delta = dimDelta(event.data);
    if (delta === null) return;
    const current = target.get(delta.requestId);
    if (current === undefined) {
      target.set(delta.requestId, {
        firstEventId: event.id,
        sequence: event.sequence,
        createdAt: createdAtOf(event.create_at),
        text: delta.delta,
      });
    } else {
      current.text += delta.delta;
    }
  };

  for (const event of input.events) {
    if (event.type === "input" && event.name === "message") {
      const user = dimUserInput(event.data);
      if (user === null) continue;
      ordered.push({
        sequence: event.sequence,
        rank: 0,
        reasoning: false,
        message: conversationMessage({
          id: input.ids.message(`user:${event.id}`),
          threadId: input.threadId,
          role: "user",
          text: user.text,
          createdAt: createdAtOf(event.create_at),
          updatedAt: createdAtOf(event.create_at),
        }),
      });
      continue;
    }
    if (event.type === "step" && event.name === "text") {
      accumulate(assistant, event);
      continue;
    }
    if (event.type === "step" && event.name === "thinking") {
      accumulate(reasoning, event);
      continue;
    }
    if (event.type === "turn" && event.name === "start") {
      const turnId = recordString(event.data, "turn_id");
      if (turnId === undefined) continue;
      turns.set(turnId, {
        sequence: event.sequence,
        startedAt: createdAtOf(event.create_at),
        completedAt: null,
        status: "running",
      });
      continue;
    }
    if (event.type === "turn" && event.name === "end") {
      const end = dimTurnEnd(event.data);
      if (end === null) continue;
      const turn = turns.get(end.turnId);
      if (turn === undefined) continue;
      turn.completedAt = createdAtOf(event.create_at);
      turn.status = end.status;
    }
  }

  const appendAssistant = (target: Map<string, TextAccumulator>, prefix: string) => {
    for (const [requestId, value] of [...target.entries()].sort(
      ([, a], [, b]) => a.sequence - b.sequence,
    )) {
      if (value.text.trim() === "") continue;
      const id = input.ids.message(`${prefix}:${requestId}`);
      ordered.push({
        sequence: value.sequence,
        rank: prefix === "reasoning" ? 2 : 1,
        reasoning: prefix === "reasoning",
        message: conversationMessage({
          id,
          threadId: input.threadId,
          role: "assistant",
          text: value.text,
          createdAt: value.createdAt,
          updatedAt: value.createdAt,
        }),
      });
    }
  };
  appendAssistant(assistant, "assistant");
  appendAssistant(reasoning, "reasoning");
  ordered.sort((left, right) => left.sequence - right.sequence || left.rank - right.rank);
  const messages = ordered.map((entry) => entry.message);
  const reasoningIds = ordered.filter((entry) => entry.reasoning).map((entry) => entry.message.id);

  const providerTurns = [...turns.entries()]
    .sort(([, a], [, b]) => a.sequence - b.sequence)
    .map(([turnId, turn], index) => ({
      id: input.ids.providerTurn(turnId),
      providerThreadId: input.providerThread.id,
      nodeId: input.ids.node(`turn:${turnId}`),
      runAttemptId: null,
      nativeTurnRef: { driver: input.driver, nativeId: turnId, strength: "strong" as const },
      ordinal: index + 1,
      status:
        turn.status === "completed"
          ? ("completed" as const)
          : turn.status === "cancelled"
            ? ("cancelled" as const)
            : turn.status === "failed"
              ? ("failed" as const)
              : ("running" as const),
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
    }));

  return { messages, providerTurns, reasoningMessageIds: reasoningIds };
}

/** The branch sequence of a turn's `turn/end`, the rest point `session.fork` accepts. */
export function dimTurnEndSequence(
  events: ReadonlyArray<DimSessionEvent["event"]>,
  turnId: string,
): number | undefined {
  for (const event of events) {
    if (event.type !== "turn" || event.name !== "end") continue;
    if (dimTurnEnd(event.data)?.turnId === turnId) return event.sequence;
  }
  return undefined;
}

/** The newest `turn/end` sequence in a branch history. */
export function dimLatestTurnEndSequence(
  events: ReadonlyArray<DimSessionEvent["event"]>,
): number | undefined {
  let latest: number | undefined;
  for (const event of events) {
    if (event.type === "turn" && event.name === "end") latest = event.sequence;
  }
  return latest;
}
