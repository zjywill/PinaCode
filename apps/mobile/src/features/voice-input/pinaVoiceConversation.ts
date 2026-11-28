import type { MessageId, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { voiceInputBlocksSubmission } from "@t3tools/client-runtime/voice-input";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { createVoiceInputTarget, type VoiceInputSession } from "./voiceInputSession";

export type PinaVoiceEndReason =
  | "connection"
  | "microphone"
  | "no-speech"
  | "send"
  | "input-required"
  | "reply"
  | "playback";

type PinaVoiceState =
  | { readonly phase: "idle"; readonly reason?: PinaVoiceEndReason }
  | { readonly phase: "listening" | "transcribing" | "speaking" }
  | { readonly phase: "waiting"; readonly messageId: MessageId };

type IncomingReply = string | null | false;

interface PinaVoiceDependencies {
  readonly listen: (signal: AbortSignal, onTranscribing: () => void) => Promise<string | null>;
  readonly send: (text: string, signal: AbortSignal) => Promise<MessageId | null>;
  readonly preserveTranscript: (text: string) => Promise<unknown>;
  readonly speak: (text: string, signal: AbortSignal) => Promise<void>;
}

export function pinaVoiceReply(
  projection: OrchestrationV2ThreadProjection | undefined,
  messageId: MessageId,
) {
  const run = projection?.runs.findLast((candidate) => candidate.userMessageId === messageId);
  if (!run?.completedAt) return undefined;
  if (run.status !== "completed") return null;
  const messages =
    projection?.messages.filter(
      (message) => message.runId === run.id && message.role === "assistant",
    ) ?? [];
  if (messages.some((message) => message.streaming)) return undefined;
  const message = messages.findLast((message) => message.text.trim().length > 0);
  return message ? searchableMessageSegments(message)?.join("\n").trim() || null : null;
}

export class PinaVoiceConversation {
  private operation: AbortController | null = null;
  private conversation: Promise<void> | null = null;
  private playback: AbortController | null = null;
  private waiting: {
    readonly messageId: MessageId;
    readonly resolve: (text: IncomingReply) => void;
  } | null = null;
  private state: PinaVoiceState = { phase: "idle" };
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(dependencies: PinaVoiceDependencies): Promise<void> {
    if (this.operation) return;
    const operation = new AbortController();
    this.operation = operation;
    const { signal } = operation;
    if (this.conversation) await this.conversation;
    if (signal.aborted) return;
    const conversation = this.run(dependencies, signal);
    this.conversation = conversation;
    await conversation;
    if (this.conversation === conversation) this.conversation = null;
  }

  private async run(dependencies: PinaVoiceDependencies, signal: AbortSignal): Promise<void> {
    let errorReason: PinaVoiceEndReason = "microphone";
    try {
      while (!signal.aborted) {
        errorReason = "microphone";
        this.publish({ phase: "listening" });
        const transcript = await dependencies.listen(signal, () => {
          if (!signal.aborted) this.publish({ phase: "transcribing" });
        });
        if (signal.aborted) {
          if (transcript) await dependencies.preserveTranscript(transcript);
          return;
        }
        if (!transcript) {
          this.end("no-speech");
          return;
        }

        errorReason = "send";
        let messageId: MessageId | null;
        try {
          messageId = await dependencies.send(transcript, signal);
        } catch {
          messageId = null;
        }
        if (!messageId) {
          await dependencies.preserveTranscript(transcript);
          if (!signal.aborted) this.end("send");
          return;
        }
        if (signal.aborted) return;

        const reply = Promise.withResolvers<IncomingReply>();
        this.waiting = { messageId, resolve: reply.resolve };
        this.publish({ phase: "waiting", messageId });
        const response = await reply.promise;
        if (signal.aborted) return;
        if (response === false) continue;
        if (!response) {
          this.end("reply");
          return;
        }

        errorReason = "playback";
        const playback = new AbortController();
        this.playback = playback;
        this.publish({ phase: "speaking" });
        try {
          await dependencies.speak(response, playback.signal);
        } catch (error) {
          if (!playback.signal.aborted) throw error;
        } finally {
          if (this.playback === playback) this.playback = null;
        }
      }
    } catch {
      if (!signal.aborted) this.end(errorReason);
    }
  }

  receiveReply(messageId: MessageId, reply: string | null) {
    if (this.waiting?.messageId !== messageId) return;
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve(reply);
  }

  interrupt() {
    if (this.playback) {
      this.playback.abort();
    } else if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = null;
      resolve(false);
    }
  }

  end(reason?: PinaVoiceEndReason) {
    if (!this.operation && reason === undefined && this.state.phase === "idle") return;
    this.operation?.abort();
    this.operation = null;
    this.playback?.abort();
    this.playback = null;
    this.waiting?.resolve(null);
    this.waiting = null;
    this.publish({ phase: "idle", ...(reason ? { reason } : {}) });
  }

  private publish(state: PinaVoiceState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export function listenForPina(
  session: VoiceInputSession,
  ownerKey: string,
  signal: AbortSignal,
  onTranscribing: () => void,
): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  if (voiceInputBlocksSubmission(session.getSnapshot().state)) {
    return Promise.reject(new Error("Another voice recording is active."));
  }
  // Updating focus publishes the previous utterance's idle state for this same owner.
  session.setOwnerFocused(ownerKey, true);
  return new Promise((resolve, reject) => {
    let transcript: string | null = null;
    const finish = (error?: string) => {
      unsubscribe();
      signal.removeEventListener("abort", cancel);
      session.setOwnerFocused(ownerKey, false);
      if (error) reject(new Error(error));
      else resolve(transcript);
    };
    const cancel = () => {
      finish();
      session.cancel(ownerKey);
    };
    const unsubscribe = session.subscribe(() => {
      const { state, ownerKey: activeOwner } = session.getSnapshot();
      if (activeOwner !== ownerKey) return;
      if (state.phase === "transcribing" || state.phase === "post-processing") onTranscribing();
      if (state.phase === "idle") finish();
      if (state.phase === "error") {
        finish(state.errorCode === "no-speech" ? undefined : (state.error ?? "Microphone failed."));
        session.cancel(ownerKey);
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    void session
      .start({
        ...createVoiceInputTarget(
          ownerKey,
          () => "",
          (text) => {
            transcript = text.trim() || null;
          },
          { start: 0, end: 0 },
        ),
        finishAfterSilence: true,
      })
      .catch(() => finish("Microphone failed."));
  });
}
