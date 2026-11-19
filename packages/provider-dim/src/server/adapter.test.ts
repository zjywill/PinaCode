import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

import { DIM_PROVIDER, makeDimAdapterV2 } from "./adapter.ts";
import type { DimNotice } from "./protocol.ts";
import type { DimConnection } from "./transport.ts";
import { DimTransportError } from "./transport.ts";

const INSTANCE_ID = ProviderInstanceId.make("dim");
const THREAD_ID = ThreadId.make("thread-adapter");
const PROVIDER_SESSION_ID = ProviderSessionId.make("provider-session-adapter");
const WORKSPACE = "/tmp/dim-adapter-workspace";
const SESSION_ID = "dim-session-1";

type Event = ProviderAdapter.ProviderAdapterV2Event;
type RuntimeMode = "full-access" | "auto-accept-edits" | "approval-required";

const layers = Layer.mergeAll(
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
);

const modelSelection = (model = "default", effort?: string): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model,
  ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
});

function attachedThread(nativeId: string): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make("provider-thread-attached"),
    driver: DIM_PROVIDER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: PROVIDER_SESSION_ID,
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: { driver: DIM_PROVIDER, nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    createdAt: DateTime.nowUnsafe(),
    updatedAt: DateTime.nowUnsafe(),
  };
}

const runtimePolicy = (runtimeMode: RuntimeMode) => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: WORKSPACE,
});

class FakeDim {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  preset: "workspace-write" | "full-access" = "full-access";
  allowedTools: string[] = [];
  disallowedTools: string[] = [];
  failSubmit = false;
  failModelUpdate = false;
  failPermissionUpdate = false;
  failFork = false;
  historyEvents: Array<{
    readonly id: string;
    readonly sequence: number;
    readonly create_at: number;
    readonly type: string;
    readonly name: string;
    readonly data: unknown;
  }> = [];
  forkSessionId = "dim-forked";
  private nextEvent = 1;
  private nextInput = 1;

  private readonly noticeQueue: Queue.Queue<DimNotice, Cause.Done>;
  private readonly closedDeferred: Deferred.Deferred<void>;

  constructor(
    noticeQueue: Queue.Queue<DimNotice, Cause.Done>,
    closedDeferred: Deferred.Deferred<void>,
  ) {
    this.noticeQueue = noticeQueue;
    this.closedDeferred = closedDeferred;
  }

  get hello() {
    return {
      instanceId: "dim-instance",
      serverVersion: "0.1.0-alpha.26",
      protocolVersion: 4,
      daemonProfile: { kind: "mock" as const },
      features: ["session.create", "session.submit"],
    };
  }

  get connection(): DimConnection {
    return {
      hello: this.hello,
      request: (method, params = {}) => this.request(method, params),
      notices: Stream.fromQueue(this.noticeQueue),
      closed: Deferred.await(this.closedDeferred),
    };
  }

  push(notice: DimNotice): void {
    Queue.offerUnsafe(this.noticeQueue, notice);
  }

  pushEvent(type: string, name: string, data: Record<string, unknown>): void {
    const sequence = this.nextEvent++;
    this.push({
      method: "session.event",
      params: {
        sessionId: SESSION_ID,
        branchId: "main",
        event: {
          id: `event-${sequence}`,
          sequence,
          create_at: sequence,
          type,
          name,
          data,
        },
      },
    });
  }

  requestsOf(method: string): ReadonlyArray<Record<string, unknown>> {
    return this.requests.filter((entry) => entry.method === method).map((entry) => entry.params);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Effect.Effect<unknown, DimTransportError> {
    this.requests.push({ method, params });
    const self = this;
    return Effect.gen(function* () {
      switch (method) {
        case "session.create":
          return {
            sessionId: SESSION_ID,
            model: { providerId: "fixture", modelId: "fixture" },
            sequence: 1,
          };
        case "session.attach":
          return {
            sessionId: SESSION_ID,
            cwd: WORKSPACE,
            model: { providerId: "fixture", modelId: "fixture" },
            createdAt: 1,
            running: false,
            sequence: 1,
            attachedClients: 1,
          };
        case "session.permission.get":
          return {
            version: 0,
            policy: {
              preset: self.preset,
              allowedTools: self.allowedTools,
              disallowedTools: self.disallowedTools,
            },
          };
        case "session.permission.update": {
          if (self.failPermissionUpdate) {
            return yield* new DimTransportError({ detail: "permission update failed" });
          }
          const policy = params["policy"] as Record<string, unknown>;
          self.preset = policy["preset"] as "workspace-write" | "full-access";
          return { version: 1, policy };
        }
        case "session.model.update":
          if (self.failModelUpdate) {
            return yield* new DimTransportError({ detail: "model update failed" });
          }
          return { model: { providerId: "fixture", modelId: "fixture" }, outcome: "changed" };
        case "session.submit": {
          if (self.failSubmit) {
            return yield* new DimTransportError({ detail: "submit failed" });
          }
          const input = self.nextInput++;
          return {
            event: {
              id: `input-${input}`,
              sequence: input,
              create_at: input,
              type: "input",
              name: "message",
              data: {
                submission_id: params["submissionId"],
                user: params["user"],
                mode: params["mode"],
              },
            },
          };
        }
        case "session.stop":
        case "session.detach":
        case "session.mcp_temporary.attach":
        case "session.mcp_temporary.renew":
        case "session.mcp_temporary.detach":
          return {};
        case "session.history":
          return {
            events: self.historyEvents,
            through: self.historyEvents.at(-1)?.sequence ?? 0,
            nextAfter: self.historyEvents.at(-1)?.sequence ?? 0,
            done: true,
          };
        case "session.fork":
          if (self.failFork) {
            return yield* new DimTransportError({ detail: "fork failed" });
          }
          return { sessionId: self.forkSessionId, sequence: 1 };
        case "session.methods":
          return {
            methods: [
              { name: "session.context.compact", mutating: true },
              { name: "session.context.usage", mutating: false },
              { name: "session.question.pending", mutating: false },
              { name: "session.question.respond", mutating: true },
              { name: "session.rename", mutating: true },
              { name: "session.exec.stop", mutating: true },
            ],
          };
        default:
          return {};
      }
    });
  }
}

const makeFakeDim = Effect.gen(function* () {
  const notices = yield* Queue.unbounded<DimNotice, Cause.Done>();
  const closed = yield* Deferred.make<void>();
  return new FakeDim(notices, closed);
});

const openHarness = (input?: {
  readonly runtimePolicy?: ReturnType<typeof runtimePolicy>;
  readonly modelSelection?: ModelSelection;
}) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeDim;
    const adapter = yield* makeDimAdapterV2({
      instanceId: INSTANCE_ID,
      connections: { connect: () => Effect.succeed(fake.connection) },
    });
    const runtime = yield* adapter.openSession({
      threadId: THREAD_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      modelSelection: input?.modelSelection ?? modelSelection(),
      runtimePolicy: input?.runtimePolicy ?? runtimePolicy("full-access"),
    });
    const events = yield* Ref.make<ReadonlyArray<Event>>([]);
    const wake = yield* Queue.unbounded<Event>();
    yield* Stream.runForEach(runtime.events, (event) =>
      Ref.update(events, (existing) => [...existing, event]).pipe(
        Effect.andThen(Queue.offer(wake, event)),
      ),
    ).pipe(Effect.forkScoped);
    const waitFor = (predicate: (event: Event) => boolean) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(wake);
          if (predicate(event)) return event;
        }
      });
    return { fake, runtime, events, waitFor };
  });

const ensureThread = (runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime) =>
  runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: modelSelection(),
    runtimePolicy: runtimePolicy("full-access"),
  });

const turnInput = (
  providerThread: OrchestrationV2ProviderThread,
  input?: {
    readonly text?: string;
    readonly runtimeMode?: RuntimeMode;
    readonly modelSelection?: ModelSelection;
  },
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: { id: THREAD_ID } as OrchestrationV2AppThread,
  threadId: THREAD_ID,
  runId: RunId.make("run-1"),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make("attempt-1"),
  rootNodeId: NodeId.make("node-root"),
  providerThread,
  message: {
    messageId: MessageId.make("message-1"),
    text: input?.text ?? "hello",
    attachments: [],
    createdBy: "user",
    creationSource: "server",
  },
  modelSelection: input?.modelSelection ?? modelSelection(),
  runtimePolicy: runtimePolicy(input?.runtimeMode ?? "full-access"),
});

const isTerminal = (event: Event) => event.type === "turn.terminal";

describe("DimAdapter turn ownership", () => {
  it.effect("ignores another Dim turn's events and binds to the admitted submission", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      yield* harness.runtime.startTurn(turnInput(thread));

      // An orphan turn, such as a dima TUI turn resumed after T3 restarted.
      harness.fake.pushEvent("turn", "start", { turn_id: "orphan" });
      harness.fake.pushEvent("step", "text", {
        turn_id: "orphan",
        request_id: "request-orphan",
        delta: "orphan text",
      });
      harness.fake.pushEvent("turn", "end", {
        turn_id: "orphan",
        status: "completed",
        reason: "end_turn",
      });
      harness.fake.push({
        method: "approval.request",
        params: {
          sessionId: SESSION_ID,
          branchId: "main",
          requestId: "orphan-approval",
          call: { name: "exec", input: { command: "id" } },
          reason: "orphan",
          source: { kind: "tool", turn_id: "orphan" },
        },
      });
      const approval = yield* harness.waitFor((event) => event.type === "runtime_request.updated");
      assert.strictEqual(
        approval.type === "runtime_request.updated"
          ? approval.runtimeRequest.providerTurnId
          : "missing",
        null,
      );

      // Dim admits our submission, then starts the turn that consumes it.
      harness.fake.pushEvent("input", "applied", { input_id: "input-1", mode: "queue" });
      harness.fake.pushEvent("turn", "start", { turn_id: "ours" });
      harness.fake.pushEvent("step", "text", {
        turn_id: "ours",
        request_id: "request-ours",
        delta: "our text",
      });
      harness.fake.pushEvent("turn", "end", {
        turn_id: "ours",
        status: "completed",
        reason: "end_turn",
      });
      yield* harness.waitFor(isTerminal);
      const seen = yield* Ref.get(harness.events);
      const assistantTexts = seen.flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [event.message.text]
          : [],
      );
      assert.deepEqual(assistantTexts, ["our text"]);
      assert.strictEqual(seen.filter(isTerminal).length, 1);
      assert.isTrue(
        seen.some(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === "ours",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});

describe("DimAdapter turn start", () => {
  it.effect("clears the turn after a rejected submit so the next turn can start", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      harness.fake.failSubmit = true;
      const failed = yield* harness.runtime.startTurn(turnInput(thread)).pipe(Effect.flip);
      assert.strictEqual(failed._tag, "ProviderAdapterTurnStartError");
      // The orchestrator writes the failed terminal from the real cause; the adapter only resets.
      assert.strictEqual(harness.runtime.providerSession.status, "ready");
      assert.strictEqual(harness.fake.requestsOf("session.submit").length, 1);

      harness.fake.failSubmit = false;
      yield* harness.runtime.startTurn(turnInput(thread));
      assert.strictEqual(harness.fake.requestsOf("session.submit").length, 2);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("refuses an empty message before touching session state", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      const failed = yield* harness.runtime
        .startTurn(turnInput(thread, { text: "" }))
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "ProviderAdapterProtocolError");
      assert.strictEqual(harness.fake.requestsOf("session.submit").length, 0);
      assert.strictEqual(harness.runtime.providerSession.status, "ready");
      yield* harness.runtime.startTurn(turnInput(thread));
      assert.strictEqual(harness.fake.requestsOf("session.submit").length, 1);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});

describe("DimAdapter runtime policy and model preferences", () => {
  it.effect("creates with the requested preset and effort, then narrows before a turn", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness({
        runtimePolicy: runtimePolicy("full-access"),
        modelSelection: modelSelection("fixture/model", "max"),
      });
      const thread = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("fixture/model", "max"),
        runtimePolicy: runtimePolicy("full-access"),
      });
      const create = harness.fake.requestsOf("session.create")[0]!;
      assert.deepEqual(create["permissionPolicy"], {
        preset: "full-access",
        allowedTools: [],
        disallowedTools: [],
      });
      assert.deepEqual(create["model"], { provider: "fixture", modelId: "model" });
      assert.deepEqual(create["modelPreferences"], { reasoningEffort: "max" });

      yield* harness.runtime.startTurn(
        turnInput(thread, {
          runtimeMode: "auto-accept-edits",
          modelSelection: modelSelection("fixture/other", "low"),
        }),
      );
      const order = harness.fake.requests.map((entry) => entry.method);
      const permissionUpdate = order.indexOf("session.permission.update");
      const modelUpdate = order.indexOf("session.model.update");
      const submit = order.indexOf("session.submit");
      assert.isAtLeast(permissionUpdate, 0);
      assert.isAtLeast(modelUpdate, 0);
      assert.isAtLeast(submit, 0);
      assert.isBelow(permissionUpdate, submit);
      assert.isBelow(modelUpdate, submit);
      assert.deepEqual(harness.fake.requestsOf("session.permission.update")[0]!["policy"], {
        preset: "workspace-write",
        allowedTools: [],
        disallowedTools: [],
      });
      assert.deepEqual(harness.fake.requestsOf("session.model.update")[0]!["modelPreferences"], {
        reasoningEffort: "low",
      });
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("does not submit a turn when the permission change fails", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      harness.fake.failPermissionUpdate = true;
      const failed = yield* harness.runtime
        .startTurn(turnInput(thread, { runtimeMode: "auto-accept-edits" }))
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "ProviderAdapterTurnStartError");
      assert.strictEqual(harness.fake.requestsOf("session.submit").length, 0);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("does not submit a turn when the model change fails", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      harness.fake.failModelUpdate = true;
      const failed = yield* harness.runtime
        .startTurn(turnInput(thread, { modelSelection: modelSelection("fixture/other") }))
        .pipe(Effect.flip);
      assert.strictEqual(failed._tag, "ProviderAdapterTurnStartError");
      assert.strictEqual(harness.fake.requestsOf("session.submit").length, 0);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("reapplies the stored preset when a thread is resumed", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      harness.fake.preset = "full-access";
      harness.fake.allowedTools = ["echo", "wait"];
      harness.fake.disallowedTools = ["exec"];
      yield* harness.runtime.resumeThread({
        providerThread: thread,
        modelSelection: modelSelection(),
        runtimePolicy: runtimePolicy("auto-accept-edits"),
      });
      assert.deepEqual(harness.fake.requestsOf("session.permission.update")[0]!["policy"], {
        preset: "workspace-write",
        allowedTools: ["echo", "wait"],
        disallowedTools: ["exec"],
      });
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});

describe("DimAdapter streaming", () => {
  it.effect("coalesces deltas into one final assistant message before the clock advances", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      yield* harness.runtime.startTurn(turnInput(thread));
      harness.fake.pushEvent("input", "applied", { input_id: "input-1", mode: "queue" });
      harness.fake.pushEvent("turn", "start", { turn_id: "turn-1" });
      for (const delta of ["one ", "two ", "three"]) {
        harness.fake.pushEvent("step", "text", {
          turn_id: "turn-1",
          request_id: "request-1",
          delta,
        });
      }
      harness.fake.pushEvent("step", "model-output-end", {
        turn_id: "turn-1",
        request_id: "request-1",
        status: "completed",
        finish_reason: "end_turn",
      });
      harness.fake.pushEvent("turn", "end", {
        turn_id: "turn-1",
        status: "completed",
        reason: "end_turn",
      });
      yield* harness.waitFor(isTerminal);
      const messages = (yield* Ref.get(harness.events)).flatMap((event) =>
        event.type === "message.updated" && event.message.role === "assistant"
          ? [event.message]
          : [],
      );
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0]!.text, "one two three");
      assert.isFalse(messages[0]!.streaming);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("flushes again after the clock advances", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      yield* harness.runtime.startTurn(turnInput(thread));
      harness.fake.pushEvent("input", "applied", { input_id: "input-1", mode: "queue" });
      harness.fake.pushEvent("turn", "start", { turn_id: "turn-1" });
      harness.fake.pushEvent("step", "text", {
        turn_id: "turn-1",
        request_id: "request-1",
        delta: "first ",
      });
      harness.fake.pushEvent("step", "text", {
        turn_id: "turn-1",
        request_id: "request-1",
        delta: "second",
      });
      yield* TestClock.adjust("50 millis");
      yield* harness.waitFor(
        (event) =>
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text === "first second",
      );
      harness.fake.pushEvent("step", "text", {
        turn_id: "turn-1",
        request_id: "request-1",
        delta: " third",
      });
      yield* TestClock.adjust("50 millis");
      yield* harness.waitFor(
        (event) =>
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.text === "first second third",
      );
      harness.fake.pushEvent("step", "model-output-end", {
        turn_id: "turn-1",
        request_id: "request-1",
        status: "completed",
        finish_reason: "end_turn",
      });
      harness.fake.pushEvent("turn", "end", {
        turn_id: "turn-1",
        status: "completed",
        reason: "end_turn",
      });
      yield* harness.waitFor(isTerminal);
      const streaming = (yield* Ref.get(harness.events)).filter(
        (event) =>
          event.type === "message.updated" &&
          event.message.role === "assistant" &&
          event.message.streaming,
      );
      assert.isAtLeast(streaming.length, 2);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});

const waitForEvent = (events: Queue.Queue<Event>, predicate: (event: Event) => boolean) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events);
      if (predicate(event)) return event;
    }
  });

describe("DimAdapter close", () => {
  it.effect("stops a T3-owned running turn when the session scope closes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeDim;
      const adapter = yield* makeDimAdapterV2({
        instanceId: INSTANCE_ID,
        connections: { connect: () => Effect.succeed(fake.connection) },
      });
      const release = yield* Deferred.make<void>();
      const running = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* adapter.openSession({
            threadId: THREAD_ID,
            providerSessionId: PROVIDER_SESSION_ID,
            modelSelection: modelSelection(),
            runtimePolicy: runtimePolicy("full-access"),
          });
          const events = yield* Queue.unbounded<Event>();
          yield* Stream.runForEach(runtime.events, (event) => Queue.offer(events, event)).pipe(
            Effect.forkScoped,
          );
          const thread = yield* ensureThread(runtime);
          yield* runtime.startTurn(turnInput(thread));
          fake.pushEvent("input", "applied", { input_id: "input-1", mode: "queue" });
          fake.pushEvent("turn", "start", { turn_id: "turn-1" });
          yield* waitForEvent(
            events,
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === "turn-1",
          );
          yield* Deferred.succeed(running, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.provide(layers), Effect.forkScoped);
      yield* Deferred.await(running);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      assert.deepEqual(fake.requestsOf("session.stop"), [
        { sessionId: SESSION_ID, branchId: "main", reason: "T3 closed the session" },
      ]);
    }).pipe(Effect.provide(layers)),
  );

  it.effect("does not stop a turn that never reached Dim", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeDim;
      const adapter = yield* makeDimAdapterV2({
        instanceId: INSTANCE_ID,
        connections: { connect: () => Effect.succeed(fake.connection) },
      });
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* adapter.openSession({
            threadId: THREAD_ID,
            providerSessionId: PROVIDER_SESSION_ID,
            modelSelection: modelSelection(),
            runtimePolicy: runtimePolicy("full-access"),
          });
          const thread = yield* ensureThread(runtime);
          yield* runtime.startTurn(turnInput(thread));
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }),
      ).pipe(Effect.provide(layers), Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      assert.strictEqual(fake.requestsOf("session.stop").length, 0);
    }).pipe(Effect.provide(layers)),
  );
});

const providerTurnStub = (
  providerThreadId: OrchestrationV2ProviderThread["id"],
  nativeTurnId: string,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`provider-turn:${nativeTurnId}`),
  providerThreadId,
  nodeId: NodeId.make(`node:${nativeTurnId}`),
  runAttemptId: null,
  nativeTurnRef: { driver: DIM_PROVIDER, nativeId: nativeTurnId, strength: "strong" },
  ordinal: 1,
  status: "completed",
  startedAt: DateTime.nowUnsafe(),
  completedAt: DateTime.nowUnsafe(),
});

describe("DimAdapter fork", () => {
  it.effect("forks at the selected turn's turn/end sequence", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      const mcp = yield* McpProviderSessions.McpProviderSessions;
      yield* mcp.set({
        environmentId: EnvironmentId.make("env-test"),
        threadId: ThreadId.make("thread-forked"),
        providerSessionId: PROVIDER_SESSION_ID,
        providerInstanceId: INSTANCE_ID,
        endpoint: "http://127.0.0.1:1234/mcp",
        authorizationHeader: "Bearer test",
        browserToolsAvailable: false,
      });
      harness.fake.historyEvents = [
        {
          id: "e2",
          sequence: 2,
          create_at: 2,
          type: "turn",
          name: "start",
          data: { turn_id: "turn-a" },
        },
        {
          id: "e8",
          sequence: 8,
          create_at: 8,
          type: "turn",
          name: "end",
          data: { turn_id: "turn-a", status: "completed", reason: "end_turn" },
        },
        {
          id: "e18",
          sequence: 18,
          create_at: 18,
          type: "turn",
          name: "end",
          data: { turn_id: "turn-b", status: "completed", reason: "end_turn" },
        },
      ];
      const sourceTurn = providerTurnStub(thread.id, "turn-a");
      const forked = yield* harness.runtime.forkThread({
        sourceProviderThread: thread,
        sourceProviderTurns: [sourceTurn],
        providerTurnId: sourceTurn.id,
        targetThreadId: ThreadId.make("thread-forked"),
      });
      assert.deepEqual(harness.fake.requestsOf("session.fork"), [{ sessionId: SESSION_ID, at: 8 }]);
      assert.strictEqual(forked.nativeThreadRef?.nativeId, harness.fake.forkSessionId);
      assert.strictEqual(forked.appThreadId, ThreadId.make("thread-forked"));
      assert.deepEqual(forked.forkedFrom, {
        providerThreadId: thread.id,
        providerTurnId: sourceTurn.id,
      });
      assert.isTrue(
        harness.fake
          .requestsOf("session.attach")
          .some((params) => params["sessionId"] === harness.fake.forkSessionId),
      );
      assert.isTrue(
        harness.fake
          .requestsOf("session.mcp_temporary.attach")
          .some((params) => params["sessionId"] === harness.fake.forkSessionId),
      );
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("detaches a source session the runtime only borrowed for the fork", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      harness.fake.historyEvents = [
        {
          id: "e2",
          sequence: 2,
          create_at: 2,
          type: "turn",
          name: "end",
          data: { turn_id: "turn-a", status: "completed", reason: "end_turn" },
        },
      ];
      const source = attachedThread("dim-source");
      yield* harness.runtime.forkThread({
        sourceProviderThread: source,
        targetThreadId: ThreadId.make("thread-forked"),
      });
      assert.deepEqual(harness.fake.requestsOf("session.attach"), [
        { sessionId: "dim-source" },
        { sessionId: harness.fake.forkSessionId },
      ]);
      assert.deepEqual(harness.fake.requestsOf("session.detach"), [{ sessionId: "dim-source" }]);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );

  it.effect("forks at the newest turn/end when no turn is selected", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      const thread = yield* ensureThread(harness.runtime);
      harness.fake.historyEvents = [
        {
          id: "e18",
          sequence: 18,
          create_at: 18,
          type: "turn",
          name: "end",
          data: { turn_id: "turn-b", status: "completed", reason: "end_turn" },
        },
      ];
      yield* harness.runtime.forkThread({
        sourceProviderThread: thread,
        targetThreadId: ThreadId.make("thread-forked"),
      });
      assert.deepEqual(harness.fake.requestsOf("session.fork"), [
        { sessionId: SESSION_ID, at: 18 },
      ]);
    }).pipe(Effect.scoped, Effect.provide(layers)),
  );
});
