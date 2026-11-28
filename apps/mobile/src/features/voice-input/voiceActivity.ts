const SPEECH_LEVEL_DB = -45;
const MIN_SPEECH_MS = 160;
const END_OF_SPEECH_MS = 1_200;
const INACTIVITY_MS = 30_000;

export function createVoiceActivityDetector() {
  let candidateStartedAt: number | null = null;
  let lastSpeechAt: number | null = null;

  return (durationMillis: number, decibels: number | undefined) => {
    if (decibels !== undefined && decibels >= SPEECH_LEVEL_DB) {
      candidateStartedAt ??= durationMillis;
      if (lastSpeechAt !== null || durationMillis - candidateStartedAt >= MIN_SPEECH_MS) {
        lastSpeechAt = durationMillis;
      }
      return "listen";
    }
    candidateStartedAt = null;
    if (lastSpeechAt !== null && durationMillis - lastSpeechAt >= END_OF_SPEECH_MS) return "finish";
    return lastSpeechAt === null && durationMillis >= INACTIVITY_MS ? "cancel" : "listen";
  };
}
