import {
  MessageId,
  RunId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  v2Now,
  v2Projection,
  v2ThreadId,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { PinaVoiceConversation, pinaVoiceReply } from "./pinaVoiceConversation";
import { createVoiceActivityDetector } from "./voiceActivity";

function waitForPhase(
  conversation: PinaVoiceConversation,
  phase: ReturnType<PinaVoiceConversation["getSnapshot"]>["phase"],
) {
  if (conversation.getSnapshot().phase === phase) return Promise.resolve();
  const observed = Promise.withResolvers<void>();
  const stop = conversation.subscribe(() => {
    if (conversation.getSnapshot().phase !== phase) return;
    stop();
    observed.resolve();
  });
  return observed.promise;
}

it("finishes after the speaker pauses and does not transcribe idle noise", () => {
  const detect = createVoiceActivityDetector();
  expect(detect(10, -20)).toBe("listen");
  expect(detect(100, -55)).toBe("listen");
  expect(detect(175, -20)).toBe("listen");
  expect(detect(335, -20)).toBe("listen");
  expect(detect(1_534, -65)).toBe("listen");
  expect(detect(1_535, -65)).toBe("finish");
  expect(createVoiceActivityDetector()(30_000, -60)).toBe("cancel");
});

it("speaks the matching response, interrupts playback and automatically listens again", async () => {
  const conversation = new PinaVoiceConversation();
  const first = MessageId.make("first");
  const second = MessageId.make("second");
  const listen = vi
    .fn()
    .mockResolvedValueOnce("How is the release?")
    .mockResolvedValueOnce("And the signing check?");
  const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const speak = vi.fn(
    async (_text: string, signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const session = conversation.start({ listen, send, speak, preserveTranscript: vi.fn() });
  await waitForPhase(conversation, "waiting");
  conversation.receiveReply(second, "A response from another turn");
  expect(speak).not.toHaveBeenCalled();
  conversation.receiveReply(first, "The release is still running.");
  await waitForPhase(conversation, "speaking");
  expect(speak).toHaveBeenCalledExactlyOnceWith(
    "The release is still running.",
    expect.any(AbortSignal),
  );

  conversation.interrupt();
  await waitForPhase(conversation, "waiting");
  expect(conversation.getSnapshot()).toEqual({ phase: "waiting", messageId: second });
  expect(send.mock.calls.map(([text]) => text)).toEqual([
    "How is the release?",
    "And the signing check?",
  ]);
  conversation.end();
  conversation.receiveReply(second, "A late reply");
  await session;
  expect(speak).toHaveBeenCalledOnce();
});

it("keeps a transcript editable when the environment cannot accept the message", async () => {
  const conversation = new PinaVoiceConversation();
  const preserveTranscript = vi.fn().mockResolvedValue(undefined);
  const speak = vi.fn();
  await conversation.start({
    listen: async () => "Show the linked task",
    send: async () => null,
    preserveTranscript,
    speak,
  });
  expect(preserveTranscript).toHaveBeenCalledExactlyOnceWith("Show the linked task");
  expect(conversation.getSnapshot()).toEqual({ phase: "idle", reason: "send" });
  expect(speak).not.toHaveBeenCalled();
});

it("selects the persisted answer to the spoken question and speaks the label of its task link", () => {
  const spokenQuestion = MessageId.make("spoken-question");
  const run: OrchestrationV2Run = {
    id: RunId.make("voice-run"),
    threadId: v2ThreadId,
    ordinal: 1,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: spokenQuestion,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: v2Now,
    checkpointId: null,
    contextHandoffId: null,
  };
  const reply: OrchestrationV2ConversationMessage = {
    id: MessageId.make("reply"),
    threadId: v2ThreadId,
    runId: run.id,
    nodeId: null,
    role: "assistant",
    createdBy: "agent",
    creationSource: "provider",
    text: "Check [the signing task](https://app.t3.codes/threads/env/signing).",
    attachments: [],
    streaming: false,
    createdAt: v2Now,
    updatedAt: v2Now,
  };
  const unrelated = { ...reply, runId: RunId.make("background-run"), text: "Unrelated reply" };
  expect(
    pinaVoiceReply({ ...v2Projection, runs: [run], messages: [reply, unrelated] }, spokenQuestion),
  ).toBe("Check the signing task.");
  expect(
    pinaVoiceReply(
      {
        ...v2Projection,
        runs: [run],
        messages: [{ ...reply, streaming: true }],
      },
      spokenQuestion,
    ),
  ).toBeUndefined();
});

it("never submits a late transcription after disconnect and saves it as text", async () => {
  const conversation = new PinaVoiceConversation();
  const recognition = Promise.withResolvers<string>();
  const send = vi.fn();
  const preserveTranscript = vi.fn().mockResolvedValue(undefined);
  const session = conversation.start({
    listen: () => recognition.promise,
    send,
    preserveTranscript,
    speak: vi.fn(),
  });
  conversation.end("connection");
  recognition.resolve("Keep these words");
  await session;
  expect(send).not.toHaveBeenCalled();
  expect(preserveTranscript).toHaveBeenCalledExactlyOnceWith("Keep these words");
  expect(conversation.getSnapshot()).toEqual({ phase: "idle", reason: "connection" });
});
