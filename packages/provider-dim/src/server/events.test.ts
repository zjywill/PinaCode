import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { assert, describe, it } from "@effect/vitest";

import {
  buildDimThreadSnapshot,
  dimEffortDescriptor,
  dimModelFromCatalog,
  dimProviderFailure,
  dimUserInput,
} from "./events.ts";

const event = (
  sequence: number,
  type: string,
  name: string,
  data: unknown,
): {
  id: string;
  sequence: number;
  create_at: number;
  type: string;
  name: string;
  data: unknown;
} => ({
  id: `event-${sequence}`,
  sequence,
  create_at: 1_700_000_000_000 + sequence,
  type,
  name,
  data,
});

const ids = {
  message: (nativeItemId: string) => MessageId.make(`message:${nativeItemId}`),
  providerTurn: (nativeTurnId: string) => ProviderTurnId.make(`turn:${nativeTurnId}`),
  node: (nativeItemId: string) => NodeId.make(`node:${nativeItemId}`),
};

const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:dim:main"),
  driver: ProviderDriverKind.make("dim"),
  providerInstanceId: ProviderInstanceId.make("dim"),
  providerSessionId: null,
  appThreadId: ThreadId.make("thread-1"),
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "idle" as const,
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  contextUsage: null,
  nativeMetadata: null,
  goal: null,
  createdAt: DateTime.nowUnsafe(),
  updatedAt: DateTime.nowUnsafe(),
};

describe("dimUserInput", () => {
  it("ignores runtime state blocks and keeps submitted user text", () => {
    assert.isNull(
      dimUserInput({
        blocks: [{ type: "raw", text: '<dim-state source="dim/environment/clients">' }],
      }),
    );
    assert.deepEqual(
      dimUserInput({
        submission_id: "submission-1",
        user: { content: [{ type: "text", text: "hello" }] },
      }),
      { submissionId: "submission-1", text: "hello" },
    );
    assert.isNull(dimUserInput({ submission_id: "submission-2", user: { content: [] } }));
  });
});

describe("buildDimThreadSnapshot", () => {
  it("rebuilds messages and turns while dropping dim-state inputs", () => {
    const snapshot = buildDimThreadSnapshot({
      events: [
        event(1, "input", "message", {
          blocks: [{ type: "raw", text: '<dim-state source="dim/environment/clients">state' }],
        }),
        event(2, "input", "message", {
          submission_id: "submission-1",
          user: { content: [{ type: "text", text: "first question" }] },
        }),
        event(3, "turn", "start", { turn_id: "turn-a" }),
        event(4, "step", "model-start", { turn_id: "turn-a", request_id: "request-1" }),
        event(5, "step", "thinking", {
          turn_id: "turn-a",
          request_id: "request-1",
          delta: "thinking",
        }),
        event(6, "step", "text", { turn_id: "turn-a", request_id: "request-1", delta: "answer " }),
        event(7, "step", "text", { turn_id: "turn-a", request_id: "request-1", delta: "done" }),
        event(8, "turn", "end", { turn_id: "turn-a", status: "completed", reason: "end_turn" }),
        event(9, "input", "message", {
          submission_id: "submission-2",
          user: { content: [{ type: "text", text: "second question" }] },
        }),
        event(10, "turn", "start", { turn_id: "turn-b" }),
        event(11, "step", "text", {
          turn_id: "turn-b",
          request_id: "request-2",
          delta: "second answer",
        }),
        event(12, "turn", "end", { turn_id: "turn-b", status: "completed", reason: "end_turn" }),
      ],
      threadId: ThreadId.make("thread-1"),
      providerThread,
      ids,
      driver: ProviderDriverKind.make("dim"),
    });

    assert.deepEqual(
      snapshot.messages.map((message) => [message.role, message.text]),
      [
        ["user", "first question"],
        ["assistant", "thinking"],
        ["assistant", "answer done"],
        ["user", "second question"],
        ["assistant", "second answer"],
      ],
    );
    assert.deepEqual(snapshot.reasoningMessageIds, [MessageId.make("message:reasoning:request-1")]);
    assert.strictEqual(snapshot.providerTurns.length, 2);
    assert.strictEqual(snapshot.providerTurns[0]!.id, ProviderTurnId.make("turn:turn-a"));
    assert.strictEqual(snapshot.providerTurns[0]!.ordinal, 1);
    assert.strictEqual(snapshot.providerTurns[0]!.status, "completed");
    assert.strictEqual(snapshot.providerTurns[1]!.id, ProviderTurnId.make("turn:turn-b"));
    assert.strictEqual(snapshot.providerTurns[1]!.ordinal, 2);
  });

  it("leaves an unfinished turn running", () => {
    const snapshot = buildDimThreadSnapshot({
      events: [event(1, "turn", "start", { turn_id: "turn-a" })],
      threadId: ThreadId.make("thread-1"),
      providerThread,
      ids,
      driver: ProviderDriverKind.make("dim"),
    });
    assert.strictEqual(snapshot.providerTurns[0]!.status, "running");
    assert.isNull(snapshot.providerTurns[0]!.completedAt);
  });
});

describe("dimEffortDescriptor", () => {
  it("offers declared efforts plus none, defaulting to the declared effort", () => {
    const descriptor = dimEffortDescriptor({
      reasoning: {
        supported: true,
        effort: "high",
        effortOptions: ["low", "high", "max"],
        off: { kind: "thinking_type", value: "disabled" },
      },
    });
    assert.isDefined(descriptor);
    assert.strictEqual(descriptor!.type, "select");
    assert.strictEqual(descriptor!.id, "effort");
    assert.isTrue(descriptor!.type === "select" && descriptor!.role === "reasoning");
    assert.strictEqual(descriptor!.currentValue, "high");
    assert.deepEqual(
      descriptor!.type === "select" ? descriptor!.options.map((option) => option.id) : [],
      ["default", "low", "high", "max", "none"],
    );
    assert.isTrue(
      descriptor!.type === "select" &&
        descriptor!.options.find((option) => option.id === "high")?.isDefault === true,
    );
  });

  it("omits the control for models without reasoning", () => {
    assert.isUndefined(dimEffortDescriptor({ reasoning: { supported: false } }));
    assert.isUndefined(dimEffortDescriptor(undefined));
  });
});

describe("dimModelFromCatalog", () => {
  it("skips unavailable models and keeps the context window", () => {
    const model = dimModelFromCatalog({
      providerId: "dimcode-api-oauth",
      providerName: "Dim",
      model: {
        id: "gpt-5",
        name: "GPT-5",
        capabilities: { contextWindow: 200_000, maxOutputTokens: 8_192 },
        metadata: { reasoning: { supported: true, effortOptions: ["low", "high"] } },
      },
    });
    assert.isDefined(model);
    assert.strictEqual(model!.contextWindow, 200_000);
    assert.strictEqual(model!.model.slug, "dimcode-api-oauth/gpt-5");
    assert.strictEqual(model!.model.name, "GPT-5");
    assert.strictEqual(model!.model.subProvider, "Dim");
    assert.isUndefined(
      dimModelFromCatalog({
        providerId: "p",
        providerName: "P",
        model: { id: "m", unavailableReason: "provider_unavailable" },
      }),
    );
  });
});

describe("dimProviderFailure", () => {
  it("maps Dim failure kinds to T3 classes", () => {
    const rate = dimProviderFailure({ error: "rate", failure: { kind: "rate_limited" } });
    assert.strictEqual(rate.class, "usage_limit");
    assert.strictEqual(rate.code, "rate_limited");
    const plain = dimProviderFailure({ error: "boom" });
    assert.strictEqual(plain.class, "provider_error");
    assert.strictEqual(plain.message, "boom");
  });
});
