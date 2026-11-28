import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

export async function speakPinaReply(text: string, signal: AbortSignal): Promise<void> {
  const speech = await import("expo-speech");
  if (signal.aborted) return;
  const interrupted = new AbortController();
  const stop = () => interrupted.abort();
  const token = acquireAudioSession("playback", stop);
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (!(await activateAudioSession(token)) || interrupted.signal.aborted) {
      if (signal.aborted) return;
      throw new Error("Audio output is unavailable.");
    }
    // Android limits the size of an utterance. Keep sentence-sized chunks for a responsive stop.
    const limit = Math.min(speech.maxSpeechInputLength, 750);
    let rest = text;
    while (rest && !interrupted.signal.aborted) {
      const prefix = rest.slice(0, limit);
      const boundary =
        rest.length <= limit
          ? rest.length
          : Math.max(prefix.lastIndexOf(" ") + 1, prefix.lastIndexOf("\n") + 1);
      const end = boundary > 0 ? boundary : prefix.length;
      const length = splitsSurrogatePair(rest, end) ? end - 1 : end;
      const chunk = rest.slice(0, length);
      rest = rest.slice(length).trimStart();
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          interrupted.signal.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => {
          // Some engines call onStopped before the stop request has actually settled.
          void speech.stop().then(() => finish(), finish);
        };
        interrupted.signal.addEventListener("abort", cancel, { once: true });
        try {
          speech.speak(chunk, {
            useApplicationAudioSession: true,
            onDone: () => finish(),
            onStopped: () => {
              if (!interrupted.signal.aborted) finish(new Error("Speech was interrupted."));
            },
            onError: (error) => finish(error),
          });
        } catch (error) {
          finish(error);
        }
      });
    }
    if (interrupted.signal.aborted && !signal.aborted) {
      throw new Error("Audio output was interrupted.");
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await releaseAudioSession(token);
  }
}
