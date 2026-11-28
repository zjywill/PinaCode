import type { MessageId, OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { View } from "react-native";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { Notice } from "../../components/ui/Notice";
import { useBarInset } from "../../components/ui/useBarInset";
import { useAppForeground } from "../../lib/appState";
import { mergeComposerDraftContent } from "../../state/use-composer-drafts";
import { useGlobalVoiceInput } from "../voice-input/VoiceInputProvider";
import {
  listenForPina,
  PinaVoiceConversation,
  pinaVoiceReply,
} from "../voice-input/pinaVoiceConversation";
import { speakPinaReply } from "../voice-input/pinaVoicePlayback";
import { ThreadHeader } from "./ThreadHeader";

export function PinaVoiceThreadHeader({
  canOperate,
  connected,
  needsInput,
  threadKey,
  projection,
  onSendVoice,
  interruptibleRunId,
  onInterruptVoice,
  ...header
}: ComponentProps<typeof ThreadHeader> & {
  readonly canOperate: boolean;
  readonly connected: boolean;
  readonly needsInput: boolean;
  readonly threadKey: string;
  readonly projection: OrchestrationV2ThreadProjection | undefined;
  readonly onSendVoice: (text: string, signal: AbortSignal) => Promise<MessageId | null>;
  readonly interruptibleRunId: RunId | null;
  readonly onInterruptVoice: () => Promise<unknown> | void;
}) {
  const gt = useGT();
  const noticeTop = useBarInset() + 8;
  const [conversation] = useState(() => new PinaVoiceConversation());
  const state = useSyncExternalStore(conversation.subscribe, conversation.getSnapshot);
  const {
    session,
    isAvailable,
    ownerKey: activeRecordingOwner,
    state: recording,
  } = useGlobalVoiceInput();
  const isForeground = useAppForeground();
  const active = state.phase !== "idle";
  const canOperateVoice = connected && canOperate && !needsInput;
  const available = canOperateVoice && isForeground;
  // The recorder handles backgrounding while listening, including Android's permission activity.
  const canContinue = canOperateVoice && (isForeground || state.phase === "listening");
  const ownerKey = `pina-voice:${threadKey}`;
  const send = useRef(onSendVoice);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- an active native session sends each utterance with the latest thread permissions and settings
  useLayoutEffect(() => {
    send.current = onSendVoice;
  }, [onSendVoice]);

  useFocusEffect(useCallback(() => () => conversation.end(), [conversation]));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the native audio session when the app, connection or permissions no longer allow it
  useEffect(() => {
    if (!active || canContinue) return;
    if (needsInput) conversation.end("input-required");
    else if (!connected) conversation.end("connection");
    else conversation.end();
  }, [active, canContinue, connected, needsInput, conversation]);

  const waitingMessage = state.phase === "waiting" ? state.messageId : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- feeds a reply from this thread subscription into the waiting native conversation
  useEffect(() => {
    if (waitingMessage === null || !available) return;
    const reply = pinaVoiceReply(projection, waitingMessage);
    if (reply !== undefined) conversation.receiveReply(waitingMessage, reply);
  }, [available, conversation, projection, waitingMessage]);

  const startVoice = () => {
    if (!available) return;
    if (!isAvailable) {
      conversation.end("microphone");
      return;
    }
    void conversation.start({
      listen: (signal, onTranscribing) => listenForPina(session, ownerKey, signal, onTranscribing),
      send: (text, signal) => send.current(text, signal),
      preserveTranscript: (text) => mergeComposerDraftContent(threadKey, { text, attachments: [] }),
      speak: speakPinaReply,
    });
  };
  const canInterruptRun =
    waitingMessage !== null &&
    interruptibleRunId !== null &&
    projection?.runs.some(
      (run) => run.id === interruptibleRunId && run.userMessageId === waitingMessage,
    ) === true;
  const voiceActions: AppBarAction[] = active
    ? [
        ...(state.phase === "speaking" || canInterruptRun
          ? [
              {
                accessibilityLabel: gt("Interrupt Pina"),
                icon: "stop.fill" as const,
                onPress: () => {
                  if (canInterruptRun) void onInterruptVoice();
                  conversation.interrupt();
                },
              },
            ]
          : []),
        {
          accessibilityLabel: gt("End voice conversation"),
          icon: "xmark",
          onPress: () => conversation.end(),
        },
        ...(state.phase === "listening" &&
        activeRecordingOwner === ownerKey &&
        recording.phase === "recording"
          ? [
              {
                accessibilityLabel: gt("Send voice turn"),
                icon: "arrow.up" as const,
                onPress: () => void session.controller.stop(),
              },
            ]
          : []),
      ]
    : canOperate
      ? [
          {
            accessibilityLabel: gt("Start voice conversation with Pina"),
            icon: "mic",
            disabled: !available,
            onPress: startVoice,
          },
        ]
      : [];
  const status = (() => {
    switch (state.phase) {
      case "listening":
        return gt("Listening to you…");
      case "transcribing":
        return gt("Transcribing…");
      case "waiting":
        return gt("Waiting for Pina…");
      case "speaking":
        return gt("Pina is speaking…");
      case "idle":
        switch (state.reason) {
          case "connection":
            return gt("Connection lost. Continue in chat.");
          case "microphone":
            return gt("Microphone unavailable. Continue in chat.");
          case "no-speech":
            return gt("No speech detected. Continue in chat.");
          case "input-required":
            return gt("Continue in chat to respond.");
          case "send":
            return gt("Voice message unsent. Check your draft.");
          case "reply":
          case "playback":
            return gt("Continue in chat to see Pina’s response.");
          default:
            return undefined;
        }
    }
  })();
  return (
    <>
      <ThreadHeader
        {...header}
        subtitle={(active ? status : undefined) ?? header.subtitle}
        actions={voiceActions}
        threadTools={active ? "hidden" : "menu"}
      />
      {!active && status !== undefined ? (
        <View
          className="absolute inset-x-3 z-20"
          style={{ top: noticeTop }}
          pointerEvents="box-none"
        >
          <Notice
            message={status}
            icon="exclamationmark.circle"
            floating
            onDismiss={() => conversation.end()}
          />
        </View>
      ) : null}
    </>
  );
}
