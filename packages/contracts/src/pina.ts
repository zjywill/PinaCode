import { ThreadId, type ProjectId } from "./baseSchemas.ts";

export const PINA_ASSISTANT_NAME = "Pina";
const PINA_THREAD_PREFIX = "pina-assistant-";
export const pinaThreadId = (projectId: ProjectId, generation: number) =>
  ThreadId.make(`${PINA_THREAD_PREFIX}${projectId}-${generation}`);
export const isPinaThread = (threadId: ThreadId) => threadId.startsWith(PINA_THREAD_PREFIX);
