import { expect, it, vi } from "vite-plus/test";
import { speakPinaReply } from "./pinaVoicePlayback";

const audio = vi.hoisted(() => ({
  activate: vi.fn(async () => true),
  release: vi.fn(async () => undefined),
  speak: vi.fn<(text: string, callbacks: { onDone: () => void; onStopped: () => void }) => void>(),
  stop: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../lib/audioSession", () => ({
  acquireAudioSession: () => ({}),
  activateAudioSession: audio.activate,
  releaseAudioSession: audio.release,
}));

vi.mock("expo-speech", () => ({
  maxSpeechInputLength: 25,
  speak: audio.speak,
  stop: audio.stop,
}));

it("waits for native playback to stop before returning the microphone to the conversation", async () => {
  audio.release.mockClear();
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  audio.speak.mockImplementation((_text, callbacks) => {
    audio.stop.mockImplementation(() => {
      callbacks.onStopped();
      return stopped.promise;
    });
    started.resolve();
  });
  const interrupt = new AbortController();
  const playback = speakPinaReply("You can interrupt this reply.", interrupt.signal);
  await started.promise;
  expect(audio.speak).toHaveBeenCalledWith("You can interrupt this ", expect.anything());
  interrupt.abort();
  expect(audio.stop).toHaveBeenCalledOnce();
  expect(audio.release).not.toHaveBeenCalled();
  stopped.resolve();
  await playback;
  expect(audio.release).toHaveBeenCalledOnce();
  expect(audio.speak).toHaveBeenCalledOnce();
});
