// @effect-diagnostics effectFnOpportunity:off -- session-local helpers close over one connection; a span per helper would repeat per session.
import type {
  MessageId,
  ModelSelection,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";

import {
  buildDimThreadSnapshot,
  dimApprovalKind,
  dimApprovalOptions,
  dimDelta,
  dimModelOutputEnd,
  dimModelProgress,
  dimProviderFailure,
  dimAskUserQuestions,
  dimToolCalls,
  dimToolItemKind,
  dimToolResults,
  dimLatestTurnEndSequence,
  dimToolUse,
  dimTurnEnd,
  dimTurnEndSequence,
  dimUserInput,
} from "./events.ts";
import {
  DIM_BRANCH,
  isRecord,
  parseDimEvent,
  parseDimModelSlug,
  recordArray,
  recordField,
  recordNumber,
  recordString,
  dimEvent,
  dimState,
  type DimCreateResult,
  type DimHistoryResult,
  type DimNotice,
  type DimSessionEvent,
} from "./protocol.ts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type { DimDaemonError } from "./daemon.ts";
import type { DimConnection, DimConnectionError } from "./transport.ts";

export const DIM_PROVIDER: ProviderDriverKind = ProviderDriverKind.make("dim");

const DIM_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
};

const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);

const STREAM_FLUSH_MS = 50;
const DIM_MCP_LEASE_RENEW = "15 seconds";
const DIM_MCP_ATTACH_TIMEOUT = "5 seconds";
const DIM_CONTEXT_USAGE_TIMEOUT = "2 seconds";
const DIM_STEER_TIMEOUT = "10 seconds";
const DIM_MAX_SEEN_EVENT_IDS = 2_048;

export type DimConnectionFactoryError = DimConnectionError | DimDaemonError;

export interface DimConnectionFactory {
  readonly connect: (input: {
    readonly threadId: ThreadId;
    readonly clientName: string;
  }) => Effect.Effect<DimConnection, DimConnectionFactoryError, Scope.Scope>;
}

export interface DimAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly connections: DimConnectionFactory;
  readonly modelContextWindows?: Ref.Ref<ReadonlyMap<string, number>>;
}

interface ToolItemState {
  readonly nativeItemId: string;
  readonly name: string;
  readonly startedAt: DateTime.Utc;
  input: Record<string, unknown>;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  output?: string;
  structured?: unknown;
  taskId?: string;
}

interface ActiveDimTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  dimTurnId: string | null;
  readonly startedAt: DateTime.Utc;
  readonly submissionId: string;
  inputEventId: string | null;
  startApplied: boolean;
  readonly compact: boolean;
  pendingStopReason: string | null;
  stopSent: boolean;
  readonly itemOrdinals: Map<string, number>;
  nextOrdinal: number;
  readonly textByRequest: Map<string, StreamState>;
  readonly thinkingByRequest: Map<string, StreamState>;
  /** The last live text/thinking each request reported before its `step/*` commit. */
  readonly progressByRequest: Map<string, DimProgressSnapshot>;
  readonly toolItems: Map<string, ToolItemState>;
  readonly steers: Map<
    string,
    { messageId: MessageId; inputEventId: string | null; done: boolean }
  >;
  lastFailure: OrchestrationV2ProviderFailure | null;
}

interface DimProgressSnapshot {
  readonly text: string;
  readonly textOffset: number;
  readonly thinking: string;
  readonly thinkingOffset: number;
}

interface StreamState {
  text: string;
  readonly startedAt: DateTime.Utc;
  completed: boolean;
  flushScheduled: boolean;
  flushFiber: Fiber.Fiber<void, never> | null;
}

interface PendingApproval {
  readonly nativeRequestId: string;
  readonly requestId: RuntimeRequestId;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  turnItem: OrchestrationV2TurnItem;
}

interface PendingQuestion {
  /** The batch's `request_id` from `step/tool-call`. */
  readonly dimRequestId: string;
  readonly callId: string;
  readonly requestId: RuntimeRequestId;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  turnItem: OrchestrationV2TurnItem;
}

interface ThreadState {
  readonly sessionId: string;
  readonly cwd: string;
  providerThread: OrchestrationV2ProviderThread;
}

const protocolError = (detail: string) =>
  new ProviderAdapter.ProviderAdapterProtocolError({ driver: DIM_PROVIDER, detail });

function dimPreset(runtimeMode: string): "workspace-write" | "full-access" {
  return runtimeMode === "full-access" ? "full-access" : "workspace-write";
}

function dimSelection(selection: ModelSelection): {
  readonly model: { provider: string; modelId: string } | null;
  readonly effort: string | null;
} {
  const parsed = parseDimModelSlug(selection.model);
  const effort = selection.options?.find((option) => option.id === "effort")?.value;
  return {
    model: parsed === null ? null : { provider: parsed.providerId, modelId: parsed.modelId },
    effort: typeof effort === "string" && effort !== "default" ? effort : null,
  };
}

/** The `session.question.respond` answers, or null when a question has no answer Dim accepts. */
function dimQuestionAnswers(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): ReadonlyArray<{ questionId: string; selected: ReadonlyArray<string>; custom?: string }> | null {
  const mapped: Array<{
    questionId: string;
    selected: ReadonlyArray<string>;
    custom?: string;
  }> = [];
  for (const question of questions) {
    const raw = answers[question.id];
    const values =
      typeof raw === "string"
        ? [raw]
        : Array.isArray(raw)
          ? raw.filter((value): value is string => typeof value === "string")
          : [];
    if (values.length === 0) return null;
    const labels = new Set(question.options.map((option) => option.label));
    const selected: string[] = [];
    let custom: string | undefined;
    for (const value of values) {
      if (labels.has(value)) {
        if (!selected.includes(value)) selected.push(value);
      } else if (custom === undefined) {
        custom = value;
      } else {
        return null;
      }
    }
    if (question.multiSelect !== true && selected.length > 1) return null;
    if (selected.length > 0 && question.multiSelect !== true) custom = undefined;
    if (selected.length === 0 && custom === undefined) return null;
    if (custom !== undefined && (question.allowCustomAnswer === false || custom.trim() === "")) {
      return null;
    }
    mapped.push({ questionId: question.id, selected, ...(custom === undefined ? {} : { custom }) });
  }
  return mapped;
}

const decodeCreate = (
  value: unknown,
): Effect.Effect<DimCreateResult, ProviderAdapter.ProviderAdapterProtocolError> =>
  Effect.suspend(() => {
    const sessionId = recordString(value, "sessionId");
    return sessionId === undefined
      ? Effect.fail(protocolError("Dim session.create returned no sessionId"))
      : Effect.succeed(value as DimCreateResult);
  });

const decodeHistory = (
  value: unknown,
): Effect.Effect<DimHistoryResult, ProviderAdapter.ProviderAdapterProtocolError> =>
  Effect.suspend(() => {
    const record = isRecord(value) ? value : {};
    const events = recordArray(record, "events");
    if (events === undefined) {
      return Effect.fail(protocolError("Dim session.history returned no events"));
    }
    return Effect.succeed({
      events: events.flatMap((event) => {
        const parsed = parseDimEvent(event);
        return parsed === null ? [] : [parsed];
      }),
      through: typeof record["through"] === "number" ? record["through"] : 0,
      nextAfter: typeof record["nextAfter"] === "number" ? record["nextAfter"] : 0,
      done: record["done"] === true,
    });
  });

export const makeDimAdapterV2 = Effect.fn("DimAdapter.make")(function* (
  options: DimAdapterOptions,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const contextWindows: Ref.Ref<ReadonlyMap<string, number>> =
    options.modelContextWindows ?? (yield* Ref.make<ReadonlyMap<string, number>>(new Map()));

  return {
    instanceId: options.instanceId,
    driver: DIM_PROVIDER,
    getCapabilities: Effect.fn("DimAdapter.getCapabilities")(function () {
      return Effect.succeed(DIM_CAPABILITIES);
    }),
    planSelectionTransition: Effect.fn("DimAdapter.planSelectionTransition")(function () {
      return Effect.succeed(turnScopedSelectionTransition());
    }),
    openSession: Effect.fn("DimAdapter.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      const scope = yield* Effect.scope;
      const connection = yield* options.connections
        .connect({ threadId: input.threadId, clientName: "T3 Code" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: DIM_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
        );
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const createdAt = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: DIM_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "starting",
        cwd: input.runtimePolicy.cwd ?? host.paths.cwd,
        model: input.modelSelection.model,
        capabilities: DIM_CAPABILITIES,
        extensionStatuses: [],
        createdAt,
        updatedAt: createdAt,
        lastError: null,
      };
      let threadState: ThreadState | null = null;
      let activeTurn: ActiveDimTurn | null = null;
      let closed = false;
      let appliedModel: string | null = null;
      let defaultModel: { provider: string; modelId: string } | null = null;
      let appliedEffort: string | null = null;
      let appliedPreset: "workspace-write" | "full-access" | null = null;
      let sessionMethods: { sessionId: string; names: ReadonlySet<string> } | null = null;
      let mcpBindingId: string | null = null;
      let mcpAttachedFor: string | null = null;
      let mcpRenew: Fiber.Fiber<void, never> | null = null;
      let pendingImport: string | null | undefined = input.initialNativeThreadId;
      const pendingApprovals = new Map<string, PendingApproval>();
      const pendingQuestions = new Map<string, PendingQuestion>();
      const backgroundTasks = new Map<
        string,
        { readonly description: string | null; readonly nativeItemId: string | null }
      >();
      const seenEventIds = new Set<string>();
      const seenOrder: string[] = [];

      const updateSession = Effect.fn("DimAdapter.updateSession")(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        const updatedAt = yield* DateTime.now;
        sessionEntity = { ...sessionEntity, status, lastError, updatedAt };
        yield* emit({
          type: "provider_session.updated",
          driver: DIM_PROVIDER,
          providerSession: sessionEntity,
        });
      });

      yield* updateSession("ready");

      const rememberEvent = (id: string): boolean => {
        if (seenEventIds.has(id)) return false;
        seenEventIds.add(id);
        seenOrder.push(id);
        if (seenOrder.length > DIM_MAX_SEEN_EVENT_IDS) {
          const oldest = seenOrder.shift();
          if (oldest !== undefined) seenEventIds.delete(oldest);
        }
        return true;
      };

      const itemOrdinal = (turn: ActiveDimTurn, nativeItemId: string): number => {
        const existing = turn.itemOrdinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextOrdinal++;
        turn.itemOrdinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const itemBase = (
        turn: ActiveDimTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: DIM_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.turnInput.threadId,
        runId: turn.turnInput.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({ driver: DIM_PROVIDER, nativeItemId }),
        providerThreadId: turn.turnInput.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: {
          driver: DIM_PROVIDER,
          nativeId: nativeItemId,
          strength: "strong" as const,
        },
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const emitNode = (
        turn: ActiveDimTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: DIM_PROVIDER,
          node: {
            id: idAllocator.derive.nodeFromProviderItem({ driver: DIM_PROVIDER, nativeItemId }),
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            parentNodeId: turn.turnInput.rootNodeId,
            rootNodeId: turn.turnInput.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: { driver: DIM_PROVIDER, nativeId: nativeItemId, strength: "strong" },
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });

      // Progress offsets count Unicode scalars, so slice by code point rather than UTF-16.
      const scalarPrefix = (text: string, count: number) =>
        Array.from(text).slice(0, count).join("");

      /** Published text followed by the request's unpublished tail, unless newer commits make it stale. */
      const withLiveTail = (committed: string, live: string, offset: number) =>
        Array.from(committed).length <= offset ? scalarPrefix(committed, offset) + live : committed;

      const emitAssistant = Effect.fn("DimAdapter.emitAssistant")(function* (
        turn: ActiveDimTurn,
        requestId: string,
        streaming: boolean,
        status: OrchestrationV2TurnItem["status"],
      ) {
        const state = turn.textByRequest.get(requestId);
        if (state === undefined) return;
        const live = turn.progressByRequest.get(requestId);
        const shown =
          streaming && live !== undefined
            ? withLiveTail(state.text, live.text, live.textOffset)
            : state.text;
        if (shown.trim() === "") return;
        const nativeItemId = `${threadState?.sessionId ?? ""}:text:${requestId}`;
        const emittedAt = yield* DateTime.now;
        const messageId = idAllocator.derive.messageFromProviderItem({
          driver: DIM_PROVIDER,
          nativeItemId,
        });
        yield* emitNode(
          turn,
          nativeItemId,
          "assistant_message",
          streaming ? "running" : status === "completed" ? "completed" : "failed",
          state.startedAt,
          streaming ? null : emittedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: DIM_PROVIDER,
          turnItem: {
            ...itemBase(turn, nativeItemId, state.startedAt, emittedAt),
            status,
            title: null,
            completedAt: streaming ? null : emittedAt,
            type: "assistant_message",
            messageId,
            text: shown,
            streaming,
          },
        });
        yield* emit({
          type: "message.updated",
          driver: DIM_PROVIDER,
          message: {
            id: messageId,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            nodeId: idAllocator.derive.nodeFromProviderItem({
              driver: DIM_PROVIDER,
              nativeItemId,
            }),
            role: "assistant",
            text: shown,
            attachments: [],
            streaming,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: state.startedAt,
            updatedAt: emittedAt,
          },
        });
      });

      const emitReasoning = Effect.fn("DimAdapter.emitReasoning")(function* (
        turn: ActiveDimTurn,
        requestId: string,
        streaming: boolean,
        status: OrchestrationV2TurnItem["status"],
      ) {
        const state = turn.thinkingByRequest.get(requestId);
        if (state === undefined) return;
        const live = turn.progressByRequest.get(requestId);
        const shown =
          streaming && live !== undefined
            ? withLiveTail(state.text, live.thinking, live.thinkingOffset)
            : state.text;
        if (shown.trim() === "") return;
        const nativeItemId = `${threadState?.sessionId ?? ""}:thinking:${requestId}`;
        const emittedAt = yield* DateTime.now;
        yield* emitNode(
          turn,
          nativeItemId,
          "reasoning",
          streaming ? "running" : status === "completed" ? "completed" : "failed",
          state.startedAt,
          streaming ? null : emittedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: DIM_PROVIDER,
          turnItem: {
            ...itemBase(turn, nativeItemId, state.startedAt, emittedAt),
            status,
            title: null,
            completedAt: streaming ? null : emittedAt,
            type: "reasoning",
            text: shown,
            streaming,
          },
        });
      });

      /** Coalesce a turn's persisted deltas; each flush carries the text so far. */
      const scheduleStreamFlush = Effect.fn("DimAdapter.scheduleStreamFlush")(function* (
        turn: ActiveDimTurn,
        kind: "text" | "thinking",
        requestId: string,
      ) {
        const states = kind === "text" ? turn.textByRequest : turn.thinkingByRequest;
        const state = states.get(requestId);
        if (state === undefined || state.completed || state.flushScheduled) return;
        state.flushScheduled = true;
        state.flushFiber = yield* Effect.sleep(Duration.millis(STREAM_FLUSH_MS)).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              state.flushScheduled = false;
              state.flushFiber = null;
              if (state.completed) return Effect.void;
              return kind === "text"
                ? emitAssistant(turn, requestId, true, "running")
                : emitReasoning(turn, requestId, true, "running");
            }),
          ),
          Effect.forkIn(scope),
        );
      });

      const emitToolItem = Effect.fn("DimAdapter.emitToolItem")(function* (
        turn: ActiveDimTurn,
        tool: ToolItemState,
        completedAt: DateTime.Utc | null,
      ) {
        const emittedAt = completedAt ?? (yield* DateTime.now);
        const kind = dimToolItemKind(tool.name);
        yield* emitNode(
          turn,
          tool.nativeItemId,
          "tool_call",
          tool.status === "running"
            ? "running"
            : tool.status === "failed"
              ? "failed"
              : tool.status === "completed"
                ? "completed"
                : tool.status === "interrupted"
                  ? "interrupted"
                  : "cancelled",
          tool.startedAt,
          completedAt,
        );
        const base = {
          ...itemBase(turn, tool.nativeItemId, tool.startedAt, emittedAt),
          status: tool.status,
          title: tool.name,
          completedAt,
        };
        if (kind === "command_execution") {
          const input = tool.input["command"];
          yield* emit({
            type: "turn_item.updated",
            driver: DIM_PROVIDER,
            turnItem: {
              ...base,
              type: "command_execution",
              input: typeof input === "string" ? input : "",
              ...(tool.output === undefined ? {} : { output: tool.output }),
              ...(tool.status === "failed" ? { outputIndicatesFailure: true } : {}),
            },
          });
          return;
        }
        if (kind === "file_change") {
          const path = recordString(tool.input, "path") ?? "file";
          const content = recordString(tool.input, "content");
          const diff = recordString(tool.structured, "diff");
          yield* emit({
            type: "turn_item.updated",
            driver: DIM_PROVIDER,
            turnItem: {
              ...base,
              type: "file_change",
              fileName: path,
              ...(content === undefined ? {} : { newStr: content }),
              ...(diff === undefined ? {} : { diffStr: diff }),
            },
          });
          return;
        }
        yield* emit({
          type: "turn_item.updated",
          driver: DIM_PROVIDER,
          turnItem: {
            ...base,
            type: "dynamic_tool",
            toolName: tool.name,
            input: tool.input,
            ...(tool.output === undefined ? {} : { output: tool.output }),
          },
        });
      });

      const compactionTitle = (status: OrchestrationV2TurnItem["status"]): string =>
        status === "running"
          ? "Compacting context..."
          : status === "failed"
            ? "Context compaction failed"
            : status === "cancelled"
              ? "Context compaction stopped"
              : "Context compacted";

      const emitCompactionItem = Effect.fn("DimAdapter.emitCompactionItem")(function* (
        turn: ActiveDimTurn,
        status: OrchestrationV2TurnItem["status"],
        details: { readonly summary?: string } = {},
      ) {
        const emittedAt = yield* DateTime.now;
        const nativeItemId = `compaction:${turn.providerTurn.id}`;
        yield* emitNode(
          turn,
          nativeItemId,
          "system",
          status === "running" ? "running" : status,
          turn.startedAt,
          status === "running" ? null : emittedAt,
        );
        yield* emit({
          type: "turn_item.updated",
          driver: DIM_PROVIDER,
          turnItem: {
            ...itemBase(turn, nativeItemId, turn.startedAt, emittedAt),
            status,
            title: compactionTitle(status),
            completedAt: status === "running" ? null : emittedAt,
            type: "compaction",
            driver: DIM_PROVIDER,
            ...details,
          },
        });
      });

      const readContextUsage = Effect.fn("DimAdapter.readContextUsage")(function* (
        sessionId: string,
      ) {
        const reply = yield* connection
          .request(
            "session.context.usage",
            { sessionId, branchId: DIM_BRANCH },
            { timeout: DIM_CONTEXT_USAGE_TIMEOUT },
          )
          .pipe(Effect.orElseSucceed(() => undefined));
        if (reply === undefined || !isRecord(reply)) return undefined;
        const used = recordNumber(reply, "estimatedInputTokens");
        if (used === undefined) return undefined;
        const window = recordNumber(reply, "contextWindow");
        const output = recordNumber(reply, "outputTokens");
        const threshold = recordNumber(reply, "thresholdTokens");
        return {
          usedTokens: Math.max(0, Math.round(used)),
          ...(window === undefined ? {} : { maxTokens: Math.max(0, Math.round(window)) }),
          ...(output === undefined ? {} : { outputTokens: Math.max(0, Math.round(output)) }),
          ...(threshold === undefined || threshold <= 0
            ? {}
            : { autoCompactThreshold: Math.round(threshold) }),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
      });

      const finalizeTurn = Effect.fn("DimAdapter.finalizeTurn")(function* (end: {
        status: string;
        reason: string | null;
      }) {
        const turn = activeTurn;
        if (turn === null) return;
        activeTurn = null;
        const completedAt = yield* DateTime.now;
        const interrupted = turn.stopSent || turn.pendingStopReason !== null;
        const status =
          end.status === "completed"
            ? "completed"
            : end.status === "failed"
              ? "failed"
              : interrupted
                ? "interrupted"
                : "cancelled";
        for (const state of [...turn.textByRequest.values(), ...turn.thinkingByRequest.values()]) {
          if (state.flushFiber != null) {
            yield* Fiber.interrupt(state.flushFiber);
            state.flushFiber = null;
            state.flushScheduled = false;
          }
        }
        for (const [requestId, state] of turn.textByRequest) {
          if (!state.completed) {
            state.completed = true;
            yield* emitAssistant(
              turn,
              requestId,
              false,
              status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
            );
          }
        }
        for (const [requestId, state] of turn.thinkingByRequest) {
          if (!state.completed) {
            state.completed = true;
            yield* emitReasoning(
              turn,
              requestId,
              false,
              status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
            );
          }
        }
        for (const tool of turn.toolItems.values()) {
          if (tool.status !== "running") continue;
          tool.status = interrupted ? "interrupted" : "cancelled";
          yield* emitToolItem(turn, tool, completedAt);
        }
        for (const steer of turn.steers.values()) {
          if (steer.done) continue;
          steer.done = true;
          yield* emit({
            type: "steer.updated",
            driver: DIM_PROVIDER,
            threadId: turn.turnInput.threadId,
            runId: turn.turnInput.runId,
            messageId: steer.messageId,
            status: interrupted ? "cancelled" : "completed",
          });
        }
        for (const question of pendingQuestions.values()) {
          pendingQuestions.delete(String(question.requestId));
          yield* settleQuestion(question, "cancelled");
        }
        const failure =
          status === "failed"
            ? (turn.lastFailure ?? dimProviderFailure({ error: end.reason }))
            : null;
        const tokenUsage =
          threadState === null ? undefined : yield* readContextUsage(threadState.sessionId);
        yield* emit({
          type: "provider_turn.updated",
          driver: DIM_PROVIDER,
          threadId: turn.turnInput.threadId,
          providerTurn: {
            ...turn.providerTurn,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            status:
              status === "completed"
                ? "completed"
                : status === "failed"
                  ? "failed"
                  : status === "interrupted"
                    ? "interrupted"
                    : "cancelled",
            completedAt,
          },
        });
        if (threadState !== null) {
          threadState.providerThread = {
            ...threadState.providerThread,
            status: "idle",
            updatedAt: completedAt,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: DIM_PROVIDER,
            providerThread: threadState.providerThread,
          });
        }
        yield* updateSession(failure === null ? "ready" : "error", failure?.message ?? null);
        const terminalStatus =
          status === "completed"
            ? "completed"
            : status === "interrupted"
              ? "interrupted"
              : "cancelled";
        if (failure !== null) {
          const failureNativeId = `terminal-failure:${turn.providerTurn.id}`;
          const failureItem = {
            ...itemBase(turn, failureNativeId, completedAt, completedAt),
            status: "failed" as const,
            title: null,
            completedAt,
            type: "error" as const,
            failure,
          };
          yield* emit({ type: "turn_item.updated", driver: DIM_PROVIDER, turnItem: failureItem });
          yield* emit({
            type: "turn.terminal",
            driver: DIM_PROVIDER,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            failureItemOrdinal: itemOrdinal(turn, failureNativeId),
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: DIM_PROVIDER,
            providerThreadId: turn.turnInput.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.turnInput.runOrdinal,
            status: terminalStatus,
            failure: null,
            threadDisposition: "reusable",
          });
        }
      });

      const sendStop = Effect.fn("DimAdapter.sendStop")(function* (
        turn: ActiveDimTurn,
        reason: string,
      ) {
        const session = threadState;
        if (session === null) return;
        turn.stopSent = true;
        turn.pendingStopReason = null;
        yield* connection
          .request("session.stop", {
            sessionId: session.sessionId,
            branchId: DIM_BRANCH,
            reason,
          })
          .pipe(Effect.ignore);
      });

      const updateBackgroundTasks = Effect.fn("DimAdapter.updateBackgroundTasks")(function* () {
        if (threadState === null) return;
        threadState.providerThread = {
          ...threadState.providerThread,
          pendingBackgroundTasks: [...backgroundTasks.entries()].map(([taskId, task]) => ({
            kind: "command" as const,
            taskId,
            ...(task.description === null ? {} : { description: task.description }),
            ...(task.nativeItemId === null ? {} : { nativeItemId: task.nativeItemId }),
          })),
          updatedAt: yield* DateTime.now,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver: DIM_PROVIDER,
          providerThread: threadState.providerThread,
        });
      });

      const handleEvent = Effect.fn("DimAdapter.handleEvent")(function* (event: DimSessionEvent) {
        let turn = activeTurn;
        if (!isRecord(event.event.data)) return;
        const name = `${event.event.type}/${event.event.name}`;
        // Background exec outlives its turn, so these arrive with no active turn too.
        if (threadState !== null && (name === "exec/started" || name === "exec/ended")) {
          const taskId = recordString(event.event.data, "task_id");
          if (taskId === undefined) return;
          if (name === "exec/started") {
            const title = recordString(event.event.data, "title")?.trim();
            const description = recordString(event.event.data, "description")?.trim();
            const label = title !== undefined && title !== "" ? title : description;
            backgroundTasks.set(taskId, {
              description: label !== undefined && label !== "" ? label : null,
              nativeItemId: recordString(event.event.data, "call_id") ?? null,
            });
          } else {
            backgroundTasks.delete(taskId);
          }
          yield* updateBackgroundTasks();
          return;
        }
        if (turn === null || threadState === null) return;
        const data = event.event.data;
        const eventTurnId = recordString(data, "turn_id");
        const turnScoped = name === "turn/start" || name === "turn/end" || name.startsWith("step/");
        if (turnScoped && turn.dimTurnId === null && name !== "turn/start") return;
        if (
          turnScoped &&
          eventTurnId !== undefined &&
          turn.dimTurnId !== null &&
          eventTurnId !== turn.dimTurnId
        ) {
          return;
        }
        if (name === "input/message") {
          const user = dimUserInput(data);
          if (user !== null && user.submissionId === turn.submissionId) {
            turn.inputEventId = event.event.id;
          }
          const steer = [...turn.steers.entries()].find(
            ([submissionId]) => user !== null && submissionId === user.submissionId,
          );
          if (steer !== undefined) steer[1].inputEventId = event.event.id;
          return;
        }
        if (name === "input/applied") {
          const inputId = recordString(data, "input_id");
          const mode = recordString(data, "mode");
          if (inputId !== undefined && inputId === turn.inputEventId && mode !== "steer") {
            turn.startApplied = true;
          }
          return;
        }
        if (name === "input/consumed") {
          const inputId = recordString(data, "input_id");
          if (inputId === undefined) return;
          for (const steer of turn.steers.values()) {
            if (steer.inputEventId === inputId && !steer.done) {
              steer.done = true;
              yield* emit({
                type: "steer.updated",
                driver: DIM_PROVIDER,
                threadId: turn.turnInput.threadId,
                runId: turn.turnInput.runId,
                messageId: steer.messageId,
                status: "completed",
              });
            }
          }
          return;
        }
        if (name === "turn/start") {
          const dimTurnId = recordString(data, "turn_id");
          if (dimTurnId === undefined) return;
          // Dim admits our queued input with input/applied, then starts the turn that consumes it.
          if (turn.dimTurnId !== null || !turn.startApplied) return;
          turn.dimTurnId = dimTurnId;
          turn.providerTurn = {
            ...turn.providerTurn,
            nativeTurnRef: { driver: DIM_PROVIDER, nativeId: dimTurnId, strength: "strong" },
          };
          yield* emit({
            type: "provider_turn.updated",
            driver: DIM_PROVIDER,
            threadId: turn.turnInput.threadId,
            providerTurn: turn.providerTurn,
          });
          if (turn.pendingStopReason !== null) {
            yield* sendStop(turn, turn.pendingStopReason);
          }
          return;
        }
        if (name === "context/compaction-start") {
          if (turn.compact) yield* emitCompactionItem(turn, "running");
          return;
        }
        if (name === "context/compaction") {
          if (!turn.compact) return;
          const status = recordString(data, "status");
          const error = recordString(data, "error") ?? recordString(data, "reason");
          if (status === "completed" || status === "skipped") {
            yield* emitCompactionItem(turn, "completed");
            yield* finalizeTurn({ status: "completed", reason: null });
            return;
          }
          if (status === "failed") {
            turn.lastFailure = dimProviderFailure({ error: error ?? null });
            yield* emitCompactionItem(turn, "failed");
            yield* finalizeTurn({ status: "failed", reason: error ?? null });
            return;
          }
          if (status === "cancelled") {
            yield* emitCompactionItem(turn, "cancelled");
            yield* finalizeTurn({ status: "cancelled", reason: error ?? null });
            return;
          }
          return;
        }
        if (name === "step/text") {
          const delta = dimDelta(data);
          if (delta === null) return;
          const now = yield* DateTime.now;
          const existing = turn.textByRequest.get(delta.requestId);
          if (existing === undefined) {
            turn.textByRequest.set(delta.requestId, {
              text: delta.delta,
              startedAt: now,
              completed: false,
              flushScheduled: false,
              flushFiber: null,
            });
          } else {
            existing.text += delta.delta;
          }
          yield* scheduleStreamFlush(turn, "text", delta.requestId);
          return;
        }
        if (name === "step/thinking") {
          const delta = dimDelta(data);
          if (delta === null) return;
          const now = yield* DateTime.now;
          const existing = turn.thinkingByRequest.get(delta.requestId);
          if (existing === undefined) {
            turn.thinkingByRequest.set(delta.requestId, {
              text: delta.delta,
              startedAt: now,
              completed: false,
              flushScheduled: false,
              flushFiber: null,
            });
          } else {
            existing.text += delta.delta;
          }
          yield* scheduleStreamFlush(turn, "thinking", delta.requestId);
          return;
        }
        if (name === "step/model-output-end") {
          const end = dimModelOutputEnd(data);
          if (end === null) return;
          const text = turn.textByRequest.get(end.requestId);
          const thinking = turn.thinkingByRequest.get(end.requestId);
          for (const state of [text, thinking]) {
            if (state?.flushFiber != null) {
              yield* Fiber.interrupt(state.flushFiber);
              state.flushFiber = null;
              state.flushScheduled = false;
            }
            if (state !== undefined) state.completed = true;
          }
          const itemStatus =
            end.status === "completed"
              ? "completed"
              : end.status === "failed"
                ? "failed"
                : "cancelled";
          if (end.status === "failed") {
            turn.lastFailure = dimProviderFailure({
              error: end.detail,
              failure: end.failure,
            });
          }
          yield* emitAssistant(turn, end.requestId, false, itemStatus);
          yield* emitReasoning(turn, end.requestId, false, itemStatus);
          return;
        }
        if (name === "step/tool-use-start") {
          const callId = recordString(data, "call_id");
          const toolName = recordString(data, "name");
          if (callId === undefined || toolName === undefined) return;
          if (toolName === "ask_user" || turn.toolItems.has(callId)) return;
          const startedAt = yield* DateTime.now;
          turn.toolItems.set(callId, {
            nativeItemId: `tool:${callId}`,
            name: toolName,
            startedAt,
            input: {},
            status: "running",
          });
          yield* emitToolItem(turn, turn.toolItems.get(callId)!, null);
          return;
        }
        if (name === "step/tool-use") {
          const call = dimToolUse(data);
          if (call === null || call.name === "ask_user") return;
          const existing = turn.toolItems.get(call.callId);
          if (existing === undefined) {
            const startedAt = yield* DateTime.now;
            turn.toolItems.set(call.callId, {
              nativeItemId: `tool:${call.callId}`,
              name: call.name,
              startedAt,
              input: call.input,
              status: "running",
            });
          } else {
            existing.input = call.input;
          }
          yield* emitToolItem(turn, turn.toolItems.get(call.callId)!, null);
          return;
        }
        if (name === "step/tool-call") {
          const dimRequestId = recordString(data, "request_id");
          if (dimRequestId === undefined) return;
          for (const call of dimToolCalls(data)) {
            if (call.name !== "ask_user") continue;
            const questions = dimAskUserQuestions(call.input);
            if (questions === null) continue;
            yield* emitQuestion(turn, dimRequestId, call.callId, questions);
          }
          return;
        }
        if (name === "step/tool-result") {
          const completedAt = yield* DateTime.now;
          const dimRequestId = recordString(data, "request_id");
          for (const result of dimToolResults(data)) {
            if (dimRequestId !== undefined) {
              const question = findPendingQuestion(dimRequestId, result.callId);
              if (question !== undefined) {
                pendingQuestions.delete(String(question.requestId));
                yield* settleQuestion(
                  question,
                  turn.stopSent || turn.pendingStopReason !== null ? "cancelled" : "resolved",
                );
              }
            }
            const tool = turn.toolItems.get(result.callId);
            if (tool === undefined) continue;
            tool.status = result.isError
              ? turn.stopSent || turn.pendingStopReason !== null
                ? "interrupted"
                : "failed"
              : "completed";
            tool.output = result.content;
            tool.structured = result.structured;
            yield* emitToolItem(turn, tool, completedAt);
          }
          return;
        }
        if (name === "turn/end") {
          const end = dimTurnEnd(data);
          if (end === null) return;
          yield* finalizeTurn(end);
          return;
        }
      });

      const handleApprovalRequest = Effect.fn("DimAdapter.handleApprovalRequest")(function* (
        params: unknown,
      ) {
        if (!isRecord(params)) return;
        const nativeRequestId = recordString(params, "requestId");
        const call = isRecord(params["call"]) ? params["call"] : null;
        if (nativeRequestId === undefined || call === null) return;
        const name = recordString(call, "name") ?? "tool";
        const createdAt = yield* DateTime.now;
        const sourceTurnId = recordString(recordField(params, "source"), "turn_id");
        const active = activeTurn;
        // An approval from a turn this adapter does not own stays off the T3 turn.
        const turn =
          active !== null && sourceTurnId !== undefined && active.dimTurnId === sourceTurnId
            ? active
            : null;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: DIM_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const requestKind = dimApprovalKind(name);
        const threadId = turn?.turnInput.threadId ?? input.threadId;
        const providerThreadId = threadState?.providerThread.id ?? null;
        const nativeRef = {
          driver: DIM_PROVIDER,
          nativeId: nativeRequestId,
          strength: "strong" as const,
        };
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId: idAllocator.derive.approvalNode({ requestId }),
          providerTurnId: turn?.providerTurn.id ?? null,
          nativeRequestRef: nativeRef,
          kind: requestKind,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionEntity.id },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: runtimeRequest.nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? runtimeRequest.nodeId,
          kind: "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId: turn?.providerTurn.id ?? null,
          nativeItemRef: nativeRef,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId: node.id,
          providerThreadId,
          providerTurnId: turn?.providerTurn.id ?? null,
          nativeItemRef: nativeRef,
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, `approval:${nativeRequestId}`),
          status: "waiting",
          title: name,
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
          type: "approval_request",
          requestId,
          requestKind,
          prompt: name,
          ...(recordString(params, "reason") === undefined
            ? {}
            : { reason: recordString(params, "reason")! }),
          options: dimApprovalOptions(),
        };
        pendingApprovals.set(nativeRequestId, {
          nativeRequestId,
          requestId,
          runtimeRequest,
          node,
          turnItem,
        });
        yield* emit({
          type: "runtime_request.updated",
          driver: DIM_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DIM_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: DIM_PROVIDER, turnItem });
      });

      const settleApproval = Effect.fn("DimAdapter.settleApproval")(function* (
        approval: PendingApproval,
        status: "resolved" | "cancelled",
        resolution: {
          readonly decision?: ProviderApprovalDecision;
          readonly feedback?: string;
        } = {},
      ) {
        const resolvedAt = yield* DateTime.now;
        approval.runtimeRequest = {
          ...approval.runtimeRequest,
          status,
          resolvedAt,
          ...(resolution.decision === undefined ? {} : { decision: resolution.decision }),
          ...(resolution.feedback === undefined ? {} : { feedback: resolution.feedback }),
        };
        approval.node = {
          ...approval.node,
          status: status === "cancelled" ? "cancelled" : "completed",
          completedAt: resolvedAt,
        };
        approval.turnItem = {
          ...approval.turnItem,
          status: status === "cancelled" ? "cancelled" : "completed",
          completedAt: resolvedAt,
          updatedAt: resolvedAt,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: DIM_PROVIDER,
          threadId: approval.node.threadId,
          runtimeRequest: approval.runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DIM_PROVIDER, node: approval.node });
        yield* emit({
          type: "turn_item.updated",
          driver: DIM_PROVIDER,
          turnItem: approval.turnItem,
        });
      });

      const handleApprovalCancelled = Effect.fn("DimAdapter.handleApprovalCancelled")(function* (
        params: unknown,
      ) {
        const nativeRequestId = recordString(params, "requestId");
        if (nativeRequestId === undefined) return;
        const approval = pendingApprovals.get(nativeRequestId);
        if (approval === undefined) return;
        pendingApprovals.delete(nativeRequestId);
        yield* settleApproval(approval, "cancelled");
      });

      const findPendingQuestion = (dimRequestId: string, callId: string) =>
        [...pendingQuestions.values()].find(
          (entry) => entry.dimRequestId === dimRequestId && entry.callId === callId,
        );

      const emitQuestion = Effect.fn("DimAdapter.emitQuestion")(function* (
        turn: ActiveDimTurn | null,
        dimRequestId: string,
        callId: string,
        questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
      ) {
        if (findPendingQuestion(dimRequestId, callId) !== undefined) return;
        const createdAt = yield* DateTime.now;
        const nativeRequestId = `${dimRequestId}:${callId}`;
        const requestId = yield* idAllocator.allocate.runtimeRequest({
          driver: DIM_PROVIDER,
          ...(turn === null ? {} : { providerTurnId: turn.providerTurn.id }),
          nativeRequestId,
        });
        const threadId =
          turn?.turnInput.threadId ?? threadState?.providerThread.appThreadId ?? input.threadId;
        const providerThreadId = threadState?.providerThread.id ?? null;
        const providerTurnId = turn?.providerTurn.id ?? null;
        const nativeRef = {
          driver: DIM_PROVIDER,
          nativeId: nativeRequestId,
          strength: "strong" as const,
        };
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId: idAllocator.derive.approvalNode({ requestId }),
          providerTurnId,
          nativeRequestRef: nativeRef,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: sessionEntity.id },
          createdAt,
          resolvedAt: null,
        };
        const node: OrchestrationV2ExecutionNode = {
          id: runtimeRequest.nodeId,
          threadId,
          runId: turn?.turnInput.runId ?? null,
          parentNodeId: turn?.turnInput.rootNodeId ?? null,
          rootNodeId: turn?.turnInput.rootNodeId ?? runtimeRequest.nodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: nativeRef,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: createdAt,
          completedAt: null,
        };
        const turnItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: turn?.turnInput.runId ?? null,
          nodeId: node.id,
          providerThreadId,
          providerTurnId,
          nativeItemRef: nativeRef,
          parentItemId: null,
          ordinal: turn === null ? 0 : itemOrdinal(turn, `question:${nativeRequestId}`),
          status: "waiting",
          title: questions[0]?.header ?? "Question",
          startedAt: createdAt,
          completedAt: null,
          updatedAt: createdAt,
          type: "user_input_request",
          requestId,
          questions,
        };
        pendingQuestions.set(String(requestId), {
          dimRequestId,
          callId,
          requestId,
          questions,
          runtimeRequest,
          node,
          turnItem,
        });
        yield* emit({
          type: "runtime_request.updated",
          driver: DIM_PROVIDER,
          threadId,
          runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DIM_PROVIDER, node });
        yield* emit({ type: "turn_item.updated", driver: DIM_PROVIDER, turnItem });
      });

      const settleQuestion = Effect.fn("DimAdapter.settleQuestion")(function* (
        question: PendingQuestion,
        status: "resolved" | "cancelled",
        resolution: {
          readonly decision?: ProviderApprovalDecision;
          readonly answers?: ProviderUserInputAnswers;
        } = {},
      ) {
        const resolvedAt = yield* DateTime.now;
        question.runtimeRequest = {
          ...question.runtimeRequest,
          status,
          resolvedAt,
          ...(resolution.decision === undefined ? {} : { decision: resolution.decision }),
          ...(resolution.answers === undefined ? {} : { answers: resolution.answers }),
        };
        question.node = {
          ...question.node,
          status: status === "cancelled" ? "cancelled" : "completed",
          completedAt: resolvedAt,
        };
        question.turnItem = {
          ...question.turnItem,
          status: status === "cancelled" ? "cancelled" : "completed",
          completedAt: resolvedAt,
          updatedAt: resolvedAt,
        };
        yield* emit({
          type: "runtime_request.updated",
          driver: DIM_PROVIDER,
          threadId: question.node.threadId,
          runtimeRequest: question.runtimeRequest,
        });
        yield* emit({ type: "node.updated", driver: DIM_PROVIDER, node: question.node });
        yield* emit({
          type: "turn_item.updated",
          driver: DIM_PROVIDER,
          turnItem: question.turnItem,
        });
      });

      const restorePendingQuestions = Effect.fn("DimAdapter.restorePendingQuestions")(function* (
        sessionId: string,
      ) {
        const reply = yield* connection
          .request("session.question.pending", { sessionId, branchId: DIM_BRANCH })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (reply === undefined) return;
        for (const batch of recordArray(reply, "batches") ?? []) {
          if (!isRecord(batch)) continue;
          const dimRequestId = recordString(batch, "request_id");
          if (dimRequestId === undefined) continue;
          for (const call of dimToolCalls(batch)) {
            if (call.name !== "ask_user") continue;
            const questions = dimAskUserQuestions(call.input);
            if (questions === null) continue;
            yield* emitQuestion(null, dimRequestId, call.callId, questions);
          }
        }
      });

      const handleModelProgress = Effect.fn("DimAdapter.handleModelProgress")(function* (
        params: unknown,
      ) {
        const progress = dimModelProgress(params);
        if (progress === null) return;
        if (threadState !== null && progress.sessionId !== threadState.sessionId) return;
        const turn = activeTurn;
        if (turn === null || turn.dimTurnId === null) return;
        // Progress names the request it belongs to; a turn it does not match is another thread's.
        if (progress.turnId !== turn.dimTurnId || progress.requestId === null) return;
        const requestId = progress.requestId;
        turn.progressByRequest.set(requestId, {
          text: progress.text,
          textOffset: progress.textOffset,
          thinking: progress.thinking,
          thinkingOffset: progress.thinkingOffset,
        });
        const now = yield* DateTime.now;
        const ensureState = (states: Map<string, StreamState>) => {
          if (states.has(requestId)) return;
          states.set(requestId, {
            text: "",
            startedAt: now,
            completed: false,
            flushScheduled: false,
            flushFiber: null,
          });
        };
        if (progress.text !== "") {
          ensureState(turn.textByRequest);
          yield* scheduleStreamFlush(turn, "text", requestId);
        }
        if (progress.thinking !== "") {
          ensureState(turn.thinkingByRequest);
          yield* scheduleStreamFlush(turn, "thinking", requestId);
        }
      });

      const handleNotice = Effect.fn("DimAdapter.handleNotice")(function* (notice: DimNotice) {
        if (notice.method === "session.event") {
          const event = dimEvent(notice.params);
          if (event === null) return;
          if (threadState !== null && event.sessionId !== threadState.sessionId) return;
          if (!rememberEvent(event.event.id)) return;
          yield* handleEvent(event);
          return;
        }
        if (notice.method === "session.model.progress") {
          yield* handleModelProgress(notice.params);
          return;
        }
        if (notice.method === "session.state") {
          const state = dimState(notice.params);
          if (state === null) return;
          if (threadState !== null && state.sessionId !== threadState.sessionId) return;
          if (state.running && activeTurn !== null) {
            yield* updateSession("running");
          } else if (!state.running && activeTurn === null) {
            yield* updateSession("ready");
          }
          return;
        }
        if (notice.method === "approval.request") {
          const sessionId = recordString(notice.params, "sessionId");
          if (
            sessionId !== undefined &&
            threadState !== null &&
            sessionId !== threadState.sessionId
          )
            return;
          yield* handleApprovalRequest(notice.params);
          return;
        }
        if (notice.method === "approval.cancelled") {
          yield* handleApprovalCancelled(notice.params);
          return;
        }
        if (notice.method === "session.closed") {
          const sessionId = recordString(notice.params, "sessionId");
          if (
            sessionId !== undefined &&
            threadState !== null &&
            sessionId !== threadState.sessionId
          )
            return;
          if (activeTurn !== null) {
            yield* finalizeTurn({ status: "cancelled", reason: "session closed" });
          }
          yield* updateSession("stopped");
          return;
        }
      });

      yield* Stream.runForEach(connection.notices, handleNotice).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (closed) return;
            yield* Queue.fail(
              events,
              new ProviderAdapter.ProviderAdapterEventStreamError({
                driver: DIM_PROVIDER,
                providerSessionId: input.providerSessionId,
                raisedByT3: false,
                cause: "Dim connection closed",
              }),
            );
          }),
        ),
        Effect.forkIn(scope),
      );

      const resolveDefaultModel = Effect.fn("DimAdapter.resolveDefaultModel")(function* (
        cwd: string,
      ) {
        const preview = yield* connection.request("session.model.preview", { cwd });
        const model = recordField(preview, "model");
        const providerId = recordString(model, "providerId");
        const modelId = recordString(model, "modelId");
        if (providerId === undefined || modelId === undefined) {
          return yield* protocolError("Dim session.model.preview returned no default model");
        }
        return { provider: providerId, modelId };
      });

      const applySelection = Effect.fn("DimAdapter.applySelection")(function* (
        selection: ModelSelection,
      ) {
        const session = threadState;
        if (session === null) return;
        const wanted = dimSelection(selection);
        const effortKey = wanted.effort;
        if (
          wanted.model === null &&
          effortKey === null &&
          appliedModel === null &&
          appliedEffort === null
        ) {
          return;
        }
        // "Dim default" names no model; the daemon's preview says which one it means.
        const model = wanted.model ?? (defaultModel ??= yield* resolveDefaultModel(session.cwd));
        const modelKey = `${model.provider}/${model.modelId}`;
        if (modelKey === appliedModel && effortKey === appliedEffort) return;
        yield* connection.request("session.model.update", {
          sessionId: session.sessionId,
          branchId: DIM_BRANCH,
          providerId: model.provider,
          modelId: model.modelId,
          ...(effortKey === null
            ? appliedEffort === null
              ? {}
              : { modelPreferences: { reasoningEffort: { action: "clear" } } }
            : { modelPreferences: { reasoningEffort: effortKey } }),
        });
        if (modelKey !== appliedModel) {
          sessionEntity = { ...sessionEntity, model: modelKey };
          yield* updateSession(sessionEntity.status);
        }
        appliedModel = modelKey;
        appliedEffort = effortKey;
      });

      /** Dim keeps the preset across turns; apply the runtime mode before a turn can run. */
      const ensurePreset = Effect.fn("DimAdapter.ensurePreset")(function* (runtimeMode: string) {
        const session = threadState;
        if (session === null) return;
        const wanted = dimPreset(runtimeMode);
        if (appliedPreset === wanted) return;
        const current = yield* connection.request("session.permission.get", {
          sessionId: session.sessionId,
          branchId: DIM_BRANCH,
        });
        const version = recordNumber(current, "version");
        const policy = recordField(current, "policy");
        const preset = recordString(policy, "preset");
        if (preset === wanted) {
          appliedPreset = wanted;
          return;
        }
        if (version === undefined) {
          return yield* protocolError("Dim session.permission.get returned no version");
        }
        const toolNames = (field: string) =>
          (recordArray(policy, field) ?? []).filter(
            (entry): entry is string => typeof entry === "string",
          );
        yield* connection.request("session.permission.update", {
          sessionId: session.sessionId,
          branchId: DIM_BRANCH,
          expectedVersion: version,
          policy: {
            preset: wanted,
            allowedTools: toolNames("allowedTools"),
            disallowedTools: toolNames("disallowedTools"),
          },
        });
        appliedPreset = wanted;
      });

      const mcpServerConfig = (config: McpProviderSessionConfig) => ({
        type: "http" as const,
        url: config.endpoint,
        headers: { Authorization: config.authorizationHeader },
      });

      const attachMcp = Effect.fn("DimAdapter.attachMcp")(function* (
        threadId: ThreadId,
        sessionId: string,
      ) {
        if (mcpAttachedFor === sessionId) return;
        const config = yield* mcpSessions
          .read(threadId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (config === undefined) return;
        mcpBindingId ??= yield* randomUuidV4;
        const attached = yield* connection
          .request(
            "session.mcp_temporary.attach",
            {
              sessionId,
              bindingId: mcpBindingId,
              servers: { t3: mcpServerConfig(config) },
            },
            { timeout: DIM_MCP_ATTACH_TIMEOUT },
          )
          .pipe(Effect.result);
        if (attached._tag === "Failure") return;
        mcpAttachedFor = sessionId;
        if (mcpRenew !== null) yield* Fiber.interrupt(mcpRenew);
        mcpRenew = yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(DIM_MCP_LEASE_RENEW);
            if (mcpBindingId === null) return;
            yield* connection
              .request("session.mcp_temporary.renew", { sessionId, bindingId: mcpBindingId })
              .pipe(Effect.ignore);
          }),
        ).pipe(Effect.forkIn(scope));
      });

      const detachMcp = Effect.gen(function* () {
        if (mcpRenew !== null) {
          yield* Fiber.interrupt(mcpRenew);
          mcpRenew = null;
        }
        if (mcpBindingId === null || mcpAttachedFor === null) return;
        yield* connection
          .request("session.mcp_temporary.detach", {
            sessionId: mcpAttachedFor,
            bindingId: mcpBindingId,
          })
          .pipe(Effect.ignore);
        mcpAttachedFor = null;
      });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          if (mcpRenew !== null) yield* Fiber.interrupt(mcpRenew);
          const turn = activeTurn;
          const session = threadState;
          // The daemon outlives T3, so a T3-owned running turn must not keep going unseen.
          if (turn !== null && turn.dimTurnId !== null && session !== null) {
            yield* connection
              .request(
                "session.stop",
                {
                  sessionId: session.sessionId,
                  branchId: DIM_BRANCH,
                  reason: "T3 closed the session",
                },
                { timeout: Duration.millis(1_000) },
              )
              .pipe(Effect.ignore);
          }
          yield* detachMcp.pipe(Effect.timeoutOption(Duration.millis(1_000)), Effect.ignore);
        }),
      );

      const probeSessionMethods = Effect.fn("DimAdapter.probeSessionMethods")(function* (
        sessionId: string,
      ) {
        if (sessionMethods?.sessionId === sessionId) return sessionMethods.names;
        const reply = yield* connection
          .request("session.methods", { sessionId })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (reply === undefined) return null;
        const names = new Set(
          (recordArray(reply, "methods") ?? []).flatMap((entry) => {
            const name = recordString(entry, "name");
            return name === undefined ? [] : [name];
          }),
        );
        sessionMethods = { sessionId, names };
        return names;
      });

      const modelFromAttach = (reply: unknown): string | null => {
        const model = recordField(reply, "model");
        const providerId = recordString(model, "providerId");
        const modelId = recordString(model, "modelId");
        return providerId === undefined || modelId === undefined
          ? null
          : `${providerId}/${modelId}`;
      };

      const registerThread = Effect.fn("DimAdapter.registerThread")(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        if (activeTurn !== null) {
          return yield* protocolError("Cannot register a Dim thread while a turn is active");
        }
        const existing = threadInput.forceNewNativeThread
          ? undefined
          : threadInput.existingProviderThread;
        const resumeId = existing?.nativeThreadRef?.nativeId ?? null;
        const importId = resumeId === null ? (pendingImport ?? null) : null;
        const wantedSessionId = resumeId ?? importId;
        if (wantedSessionId !== null) {
          if (threadState?.sessionId === wantedSessionId) {
            threadState.providerThread = {
              ...threadState.providerThread,
              providerSessionId: input.providerSessionId,
            };
            yield* ensurePreset(threadInput.runtimePolicy.runtimeMode);
            yield* restorePendingQuestions(wantedSessionId);
            return threadState.providerThread;
          }
          const attached = yield* connection.request("session.attach", {
            sessionId: wantedSessionId,
          });
          // The session may already run another model (say, renamed in Dim's own UI).
          appliedModel = modelFromAttach(attached);
          appliedEffort = null;
          appliedPreset = null;
          yield* ensurePreset(threadInput.runtimePolicy.runtimeMode);
          const cwd = sessionEntity.cwd;
          const createdAt = yield* DateTime.now;
          const providerThread: OrchestrationV2ProviderThread = {
            ...(existing ?? {
              id: idAllocator.derive.providerThread({
                driver: DIM_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: wantedSessionId,
              }),
              driver: DIM_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              createdAt,
              updatedAt: createdAt,
            }),
            providerSessionId: input.providerSessionId,
            nativeThreadRef: {
              driver: DIM_PROVIDER,
              nativeId: wantedSessionId,
              strength: "strong",
            },
            status: "idle",
            updatedAt: createdAt,
          };
          pendingImport = null;
          threadState = { sessionId: wantedSessionId, cwd, providerThread };
          yield* emit({
            type: "provider_thread.updated",
            driver: DIM_PROVIDER,
            providerThread,
          });
          yield* updateSession("ready");
          yield* attachMcp(threadInput.threadId, wantedSessionId).pipe(Effect.ignore);
          yield* restorePendingQuestions(wantedSessionId);
          return providerThread;
        }

        const wanted = dimSelection(threadInput.modelSelection);
        const created = yield* decodeCreate(
          yield* connection.request("session.create", {
            cwd: sessionEntity.cwd,
            ...(wanted.model === null ? {} : { model: wanted.model }),
            ...(wanted.effort === null
              ? {}
              : { modelPreferences: { reasoningEffort: wanted.effort } }),
            permissionPolicy: {
              preset: dimPreset(threadInput.runtimePolicy.runtimeMode),
              allowedTools: [],
              disallowedTools: [],
            },
            interactive: true,
            origin: "client",
          }),
        );
        yield* connection.request("session.attach", { sessionId: created.sessionId });
        const createdAt = yield* DateTime.now;
        const providerThread: OrchestrationV2ProviderThread =
          existing !== undefined
            ? {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: {
                  driver: DIM_PROVIDER,
                  nativeId: created.sessionId,
                  strength: "strong",
                },
                status: "idle",
                updatedAt: createdAt,
              }
            : {
                id: idAllocator.derive.providerThread({
                  driver: DIM_PROVIDER,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: created.sessionId,
                }),
                driver: DIM_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: DIM_PROVIDER,
                  nativeId: created.sessionId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                pendingBackgroundTasks: [],
                createdAt,
                updatedAt: createdAt,
              };
        threadState = { sessionId: created.sessionId, cwd: sessionEntity.cwd, providerThread };
        appliedModel =
          wanted.model === null ? null : `${wanted.model.provider}/${wanted.model.modelId}`;
        appliedEffort = wanted.effort;
        appliedPreset = dimPreset(threadInput.runtimePolicy.runtimeMode);
        yield* emit({ type: "provider_thread.updated", driver: DIM_PROVIDER, providerThread });
        yield* updateSession("ready");
        yield* attachMcp(threadInput.threadId, created.sessionId).pipe(Effect.ignore);
        return providerThread;
      });

      const ensureThread = (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ): Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error> =>
        registerThread(threadInput).pipe(
          Effect.mapError((cause) =>
            isProviderAdapterProtocolError(cause)
              ? cause
              : new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: DIM_PROVIDER,
                  threadId: threadInput.threadId,
                  cause,
                }),
          ),
        );

      const installTurn: (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        session: ThreadState,
        compact: boolean,
      ) => Effect.Effect<ActiveDimTurn> = Effect.fn("DimAdapter.installTurn")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        session: ThreadState,
        compact: boolean,
      ) {
        const submissionId = yield* randomUuidV4;
        const startedAt = yield* DateTime.now;
        const syntheticNativeTurnId = `${session.providerThread.id}:attempt:${turnInput.attemptId}`;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: DIM_PROVIDER,
            nativeTurnId: syntheticNativeTurnId,
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef: {
            driver: DIM_PROVIDER,
            nativeId: syntheticNativeTurnId,
            strength: "weak",
          },
          nativeThreadRef: {
            driver: DIM_PROVIDER,
            nativeId: session.sessionId,
            strength: "strong",
          },
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveDimTurn = {
          turnInput,
          providerTurn,
          dimTurnId: null,
          startedAt,
          submissionId,
          inputEventId: null,
          startApplied: false,
          compact,
          pendingStopReason: null,
          stopSent: false,
          itemOrdinals: new Map(),
          nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
          textByRequest: new Map(),
          thinkingByRequest: new Map(),
          progressByRequest: new Map(),
          toolItems: new Map(),
          steers: new Map(),
          lastFailure: null,
        };
        activeTurn = turn;
        yield* emit({
          type: "provider_turn.updated",
          driver: DIM_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn,
        });
        if (threadState !== null) {
          threadState.providerThread = {
            ...threadState.providerThread,
            status: "active",
            firstRunOrdinal: threadState.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
            lastRunOrdinal: turnInput.runOrdinal,
            updatedAt: startedAt,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: DIM_PROVIDER,
            providerThread: threadState.providerThread,
          });
        }
        yield* updateSession("running");
        return turn;
      });

      const readHistory = Effect.fn("DimAdapter.readHistory")(function* (sessionId: string) {
        const collected: Array<DimSessionEvent["event"]> = [];
        let after: number | undefined;
        for (let page = 0; page < 100; page += 1) {
          const answer = yield* decodeHistory(
            yield* connection.request("session.history", {
              sessionId,
              branchId: DIM_BRANCH,
              limit: 256,
              ...(after === undefined ? {} : { after }),
            }),
          );
          collected.push(...answer.events);
          if (answer.done || answer.nextAfter === after) break;
          after = answer.nextAfter;
        }
        return collected;
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: DIM_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        canResumeAfterRestart: true,
        hasPendingBackgroundWork: Effect.sync(() => backgroundTasks.size > 0),
        stopTask: Effect.fn("DimAdapter.stopTask")(function* (taskInput: {
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly taskId: string;
        }) {
          const session = threadState;
          if (session === null || session.providerThread.id !== taskInput.providerThread.id) {
            return yield* protocolError("Dim has no such background task");
          }
          yield* connection
            .request("session.exec.stop", {
              sessionId: session.sessionId,
              branchId: DIM_BRANCH,
              taskId: taskInput.taskId,
            })
            .pipe(
              Effect.mapError((cause) =>
                protocolError(
                  `Dim did not stop background task ${taskInput.taskId}: ${cause.message}`,
                ),
              ),
            );
        }),
        getModelContextWindow: (selection) => {
          if (parseDimModelSlug(selection.model) === null) return undefined;
          return Ref.getUnsafe(contextWindows).get(selection.model);
        },
        ensureThread,
        resumeThread: (threadInput) =>
          registerThread({
            threadId:
              threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
            modelSelection: threadInput.modelSelection ?? input.modelSelection,
            runtimePolicy: threadInput.runtimePolicy ?? input.runtimePolicy,
            existingProviderThread: threadInput.providerThread,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: DIM_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: threadInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        compactThread: Effect.fn("DimAdapter.compactThread")(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          const session = threadState;
          if (session === null) {
            return yield* protocolError("Dim session has no registered thread");
          }
          if (activeTurn !== null) {
            return yield* protocolError("Dim provider thread already has an active turn");
          }
          if (turnInput.providerThread.id !== session.providerThread.id) {
            return yield* protocolError("Dim turn requested for a different thread");
          }
          const known = yield* probeSessionMethods(session.sessionId);
          if (known !== null && !known.has("session.context.compact")) {
            return yield* protocolError("Dim does not support context compaction");
          }
          const turn = yield* installTurn(turnInput, session, true);
          yield* emitCompactionItem(turn, "running");
          const result = yield* connection
            .request("session.context.compact", {
              sessionId: session.sessionId,
              branchId: DIM_BRANCH,
            })
            .pipe(Effect.result);
          // The context/compaction event may have settled the turn already.
          if (activeTurn === null) return;
          if (result._tag === "Failure") {
            const detail = result.failure.detail;
            turn.lastFailure = dimProviderFailure({ error: detail });
            yield* emitCompactionItem(turn, "failed");
            yield* finalizeTurn({ status: "failed", reason: detail });
            return;
          }
          yield* emitCompactionItem(turn, "completed");
          yield* finalizeTurn({ status: "completed", reason: null });
        }),
        startTurn: Effect.fn("DimAdapter.startTurn")(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          const session = threadState;
          if (session === null) {
            return yield* protocolError("Dim session has no registered thread");
          }
          if (activeTurn !== null) {
            return yield* protocolError("Dim provider thread already has an active turn");
          }
          if (turnInput.providerThread.id !== session.providerThread.id) {
            return yield* protocolError("Dim turn requested for a different thread");
          }
          const text = yield* providerMessageTextWithAttachmentPaths({
            text: turnInput.message.text,
            attachments: turnInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          });
          if (text.trim() === "") {
            return yield* protocolError("Dim cannot submit an empty message");
          }
          const turnError = (cause: unknown) =>
            new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: DIM_PROVIDER,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause,
            });
          // A wider stored preset must be narrowed before this turn's first tool call.
          yield* ensurePreset(turnInput.runtimePolicy.runtimeMode).pipe(Effect.mapError(turnError));
          yield* applySelection(turnInput.modelSelection).pipe(Effect.mapError(turnError));
          const turn = yield* installTurn(turnInput, session, false);
          const submitted = yield* connection
            .request("session.submit", {
              sessionId: session.sessionId,
              branchId: DIM_BRANCH,
              submissionId: turn.submissionId,
              user: { content: [{ type: "text", text }] },
              mode: "queue",
            })
            .pipe(Effect.result);
          if (submitted._tag === "Failure") {
            activeTurn = null;
            const failedAt = yield* DateTime.now;
            yield* emit({
              type: "provider_turn.updated",
              driver: DIM_PROVIDER,
              threadId: turnInput.threadId,
              providerTurn: { ...turn.providerTurn, status: "failed", completedAt: failedAt },
            });
            if (threadState !== null) {
              threadState.providerThread = {
                ...threadState.providerThread,
                status: "idle",
                updatedAt: failedAt,
              };
              yield* emit({
                type: "provider_thread.updated",
                driver: DIM_PROVIDER,
                providerThread: threadState.providerThread,
              });
            }
            yield* updateSession("ready");
            return yield* turnError(submitted.failure);
          }
          const reply = submitted.success;
          const replyEvent = isRecord(reply) && isRecord(reply["event"]) ? reply["event"] : null;
          const eventId = recordString(replyEvent, "id");
          if (eventId !== undefined) {
            rememberEvent(eventId);
            turn.inputEventId = eventId;
          }
        }),
        steerTurn: Effect.fn("DimAdapter.steerTurn")(function* (
          steerInput: ProviderAdapter.ProviderAdapterV2SteerInput,
        ) {
          const turn = activeTurn;
          const session = threadState;
          if (
            turn === null ||
            session === null ||
            turn.providerTurn.id !== steerInput.providerTurnId
          ) {
            return yield* protocolError("Dim turn is not active");
          }
          const submissionId = yield* randomUuidV4;
          turn.steers.set(submissionId, {
            messageId: steerInput.message.messageId,
            inputEventId: null,
            done: false,
          });
          yield* emit({
            type: "steer.updated",
            driver: DIM_PROVIDER,
            threadId: steerInput.threadId,
            runId: steerInput.runId,
            messageId: steerInput.message.messageId,
            status: "pending",
          });
          const text = yield* providerMessageTextWithAttachmentPaths({
            text: steerInput.message.text,
            attachments: steerInput.message.attachments,
            resolveAttachmentPath: host.resolveAttachmentPath,
            resolveExtractedTextPath: host.resolveExtractedTextPath,
          });
          yield* connection
            .request(
              "session.submit",
              {
                sessionId: session.sessionId,
                branchId: DIM_BRANCH,
                submissionId,
                user: { content: [{ type: "text", text }] },
                mode: "steer",
              },
              { timeout: DIM_STEER_TIMEOUT },
            )
            .pipe(
              Effect.tap((reply) =>
                Effect.sync(() => {
                  const replyEvent =
                    isRecord(reply) && isRecord(reply["event"]) ? reply["event"] : null;
                  const eventId = recordString(replyEvent, "id");
                  const steer = turn.steers.get(submissionId);
                  if (eventId !== undefined && steer !== undefined) {
                    rememberEvent(eventId);
                    steer.inputEventId = eventId;
                  }
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterSteerRunError({
                    driver: DIM_PROVIDER,
                    providerThreadId: steerInput.providerThread.id,
                    providerTurnId: steerInput.providerTurnId,
                    cause,
                  }),
              ),
            );
        }),
        interruptTurn: Effect.fn("DimAdapter.interruptTurn")(function* (
          interruptInput: ProviderAdapter.ProviderAdapterV2InterruptInput,
        ) {
          const turn = activeTurn;
          if (turn === null || turn.providerTurn.id !== interruptInput.providerTurnId) {
            return yield* protocolError("Dim turn is not active");
          }
          if (turn.dimTurnId === null) {
            turn.pendingStopReason = "User requested stop";
            return;
          }
          yield* sendStop(turn, "User requested stop");
        }),
        respondToRuntimeRequest: Effect.fn("DimAdapter.respondToRuntimeRequest")(function* (
          requestInput: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
        ) {
          const question = pendingQuestions.get(String(requestInput.requestId));
          if (question !== undefined) {
            const session = threadState;
            if (session === null) {
              return yield* protocolError("Dim session is not attached");
            }
            const decisionDeclines =
              requestInput.decision === "decline" || requestInput.decision === "cancel";
            const providedAnswers = requestInput.answers;
            const answers =
              decisionDeclines || providedAnswers === undefined
                ? null
                : dimQuestionAnswers(question.questions, providedAnswers);
            if (!decisionDeclines && providedAnswers !== undefined && answers === null) {
              return yield* protocolError("Dim cannot use these answers for its questions");
            }
            yield* connection
              .request("session.question.respond", {
                sessionId: session.sessionId,
                branchId: DIM_BRANCH,
                requestId: question.dimRequestId,
                callId: question.callId,
                ...(answers === null ? { declined: true } : { answers }),
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                      driver: DIM_PROVIDER,
                      requestId: requestInput.requestId,
                      cause,
                    }),
                ),
              );
            pendingQuestions.delete(String(question.requestId));
            yield* settleQuestion(
              question,
              requestInput.decision === "cancel" ? "cancelled" : "resolved",
              {
                ...(requestInput.decision === undefined ? {} : { decision: requestInput.decision }),
                ...(providedAnswers === undefined ? {} : { answers: providedAnswers }),
              },
            );
            return;
          }
          const approval = [...pendingApprovals.values()].find(
            (entry) => entry.requestId === requestInput.requestId,
          );
          if (approval === undefined) {
            return yield* protocolError("No pending Dim approval for this request");
          }
          const session = threadState;
          if (session === null) {
            return yield* protocolError("Dim session is not attached");
          }
          const decision =
            requestInput.decision === "accept"
              ? "allow"
              : requestInput.decision === "decline" || requestInput.decision === "cancel"
                ? "deny"
                : "deny";
          yield* connection
            .request("approval.respond", {
              sessionId: session.sessionId,
              branchId: DIM_BRANCH,
              requestId: approval.nativeRequestId,
              decision,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: DIM_PROVIDER,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            );
          pendingApprovals.delete(approval.nativeRequestId);
          yield* settleApproval(
            approval,
            requestInput.decision === "cancel" ? "cancelled" : "resolved",
            {
              ...(requestInput.decision === undefined ? {} : { decision: requestInput.decision }),
              ...(requestInput.feedback === undefined ? {} : { feedback: requestInput.feedback }),
            },
          );
        }),
        unloadThread: Effect.fn("DimAdapter.unloadThread")(function* () {
          const session = threadState;
          if (session === null) return;
          yield* detachMcp;
          yield* connection
            .request("session.detach", { sessionId: session.sessionId })
            .pipe(Effect.ignore);
          threadState = null;
        }),
        readThreadSnapshot: Effect.fn("DimAdapter.readThreadSnapshot")(function* (
          snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput,
        ) {
          const session = threadState;
          const wanted = snapshotInput.providerThread.nativeThreadRef?.nativeId;
          // An import opens the session for this native thread without registering it.
          const importing = threadState === null && pendingImport === wanted;
          if (
            wanted === undefined ||
            wanted === null ||
            (session?.sessionId !== wanted && !importing)
          ) {
            return yield* new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: DIM_PROVIDER,
              providerThreadId: snapshotInput.providerThread.id,
              cause: "Dim snapshot requested for a thread this session does not host",
            });
          }
          const collected = yield* readHistory(wanted).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                  driver: DIM_PROVIDER,
                  providerThreadId: snapshotInput.providerThread.id,
                  cause,
                }),
            ),
          );
          const snapshot = buildDimThreadSnapshot({
            events: collected,
            threadId: snapshotInput.providerThread.appThreadId ?? input.threadId,
            providerThread: snapshotInput.providerThread,
            driver: DIM_PROVIDER,
            ids: {
              message: (nativeItemId) =>
                idAllocator.derive.messageFromProviderItem({
                  driver: DIM_PROVIDER,
                  nativeItemId,
                }),
              providerTurn: (nativeTurnId) =>
                idAllocator.derive.providerTurn({ driver: DIM_PROVIDER, nativeTurnId }),
              node: (nativeItemId) =>
                idAllocator.derive.nodeFromProviderItem({ driver: DIM_PROVIDER, nativeItemId }),
            },
          });
          return {
            providerThread: snapshotInput.providerThread,
            providerTurns: snapshot.providerTurns,
            messages: snapshot.messages,
            reasoningMessageIds: snapshot.reasoningMessageIds,
            runtimeRequests: [],
          };
        }),
        applyModelSelection: Effect.fn("DimAdapter.applyModelSelection")(
          function* (selectionInput: {
            readonly providerThread: OrchestrationV2ProviderThread;
            readonly modelSelection: ModelSelection;
          }) {
            if (threadState?.providerThread.id !== selectionInput.providerThread.id) return;
            yield* applySelection(selectionInput.modelSelection).pipe(
              Effect.mapError((cause) =>
                isProviderAdapterProtocolError(cause)
                  ? cause
                  : protocolError(`Dim did not apply the model selection: ${cause.message}`),
              ),
            );
          },
        ),
        applyThreadTitle: Effect.fn("DimAdapter.applyThreadTitle")(function* (titleInput: {
          readonly providerThread: OrchestrationV2ProviderThread;
          readonly title: string;
        }) {
          const session = threadState;
          if (session === null || session.providerThread.id !== titleInput.providerThread.id)
            return;
          // T3 already owns the title, so the Dim mirror is best effort.
          yield* connection
            .request("session.rename", { sessionId: session.sessionId, title: titleInput.title })
            .pipe(Effect.ignore);
        }),
        rollbackThread: Effect.fn("DimAdapter.rollbackThread")(function* (
          rollbackInput: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
        ) {
          return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
            driver: DIM_PROVIDER,
            providerThreadId: rollbackInput.providerThread.id,
            cause: "Dim does not support conversation rollback",
          });
        }),
        forkThread: Effect.fn("DimAdapter.forkThread")(
          function* (forkInput: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
            if (activeTurn !== null) {
              return yield* protocolError("Cannot fork while a Dim turn is active");
            }
            const source = forkInput.sourceProviderThread;
            const sourceNativeId = source.nativeThreadRef?.nativeId;
            if (sourceNativeId === null || sourceNativeId === undefined) {
              return yield* protocolError("Dim fork source has no session id");
            }
            const attachedSource = threadState?.sessionId !== sourceNativeId;
            if (attachedSource) {
              yield* connection.request("session.attach", { sessionId: sourceNativeId });
              threadState = {
                sessionId: sourceNativeId,
                cwd: sessionEntity.cwd,
                providerThread: source,
              };
              yield* emit({
                type: "provider_thread.updated",
                driver: DIM_PROVIDER,
                providerThread: source,
              });
            }
            const history = yield* readHistory(sourceNativeId);
            const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
              (turn) => turn.providerThreadId === source.id,
            );
            const targetTurn =
              forkInput.providerTurnId === undefined
                ? undefined
                : sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
            if (forkInput.providerTurnId !== undefined && targetTurn === undefined) {
              return yield* protocolError("Dim fork target turn is missing");
            }
            const targetNativeTurnId =
              targetTurn === undefined
                ? undefined
                : (targetTurn.nativeTurnRef?.nativeId ?? undefined);
            if (targetTurn !== undefined && targetNativeTurnId === undefined) {
              return yield* protocolError("Dim fork target turn has no native id");
            }
            const at =
              targetNativeTurnId === undefined
                ? dimLatestTurnEndSequence(history)
                : dimTurnEndSequence(history, targetNativeTurnId);
            if (at === undefined) {
              return yield* protocolError("Dim fork needs a completed turn as its cut");
            }
            const reply = yield* connection.request("session.fork", {
              sessionId: sourceNativeId,
              at,
            });
            const forkedSessionId = recordString(reply, "sessionId");
            if (forkedSessionId === undefined) {
              return yield* protocolError("Dim session.fork returned no sessionId");
            }
            const forkedAttach = yield* connection.request("session.attach", {
              sessionId: forkedSessionId,
            });
            const now = yield* DateTime.now;
            const providerThread: OrchestrationV2ProviderThread = {
              id: idAllocator.derive.providerThread({
                driver: DIM_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: forkedSessionId,
              }),
              driver: DIM_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: forkInput.targetThreadId,
              ownerNodeId: forkInput.ownerNodeId ?? null,
              nativeThreadRef: {
                driver: DIM_PROVIDER,
                nativeId: forkedSessionId,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: {
                providerThreadId: source.id,
                ...(forkInput.providerTurnId === undefined
                  ? {}
                  : { providerTurnId: forkInput.providerTurnId }),
              },
              pendingBackgroundTasks: [],
              createdAt: now,
              updatedAt: now,
            };
            threadState = { sessionId: forkedSessionId, cwd: sessionEntity.cwd, providerThread };
            appliedModel = modelFromAttach(forkedAttach);
            appliedEffort = null;
            appliedPreset = null;
            yield* emit({
              type: "provider_thread.updated",
              driver: DIM_PROVIDER,
              providerThread,
            });
            yield* updateSession("ready");
            yield* attachMcp(forkInput.targetThreadId, forkedSessionId).pipe(Effect.ignore);
            // The fork borrowed the source session only to read and cut its history.
            if (attachedSource) {
              yield* connection
                .request("session.detach", { sessionId: sourceNativeId })
                .pipe(Effect.ignore);
            }
            return providerThread;
          },
          (effect, forkInput) =>
            effect.pipe(
              Effect.mapError((cause) =>
                isProviderAdapterProtocolError(cause)
                  ? cause
                  : new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver: DIM_PROVIDER,
                      providerThreadId: forkInput.sourceProviderThread.id,
                      cause,
                    }),
              ),
            ),
        ),
      };

      return runtime;
    }),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
});
