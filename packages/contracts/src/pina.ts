import { ThreadId, type ProjectId } from "./baseSchemas.ts";

export const PINA_ASSISTANT_NAME = "Pina";
const PINA_THREAD_PREFIX = "pina-assistant-";
const PINA_THREAD_ID = new RegExp(`^${PINA_THREAD_PREFIX}.+-(?:0|[1-9][0-9]*)$`, "s");
export const pinaThreadId = (projectId: ProjectId, generation: number) =>
  ThreadId.make(`${PINA_THREAD_PREFIX}${projectId}-${generation}`);
export const isPinaThread = (threadId: ThreadId) => PINA_THREAD_ID.test(threadId);
