import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString, type ProjectId } from "./baseSchemas.ts";
import type { OrchestrationV2Actor, OrchestrationV2AppThread } from "./orchestrationV2.ts";

export const PINA_ASSISTANT_NAME = "Pina";
const PINA_THREAD_PREFIX = "pina-assistant-";
const PINA_THREAD_ID = new RegExp(`^${PINA_THREAD_PREFIX}.+-(?:0|[1-9][0-9]*)$`, "s");
export const pinaThreadId = (projectId: ProjectId, generation: number) =>
  ThreadId.make(`${PINA_THREAD_PREFIX}${projectId}-${generation}`);
export const pinaConversationThreadId = (projectId: ProjectId, requestId: string) =>
  ThreadId.make(`${PINA_THREAD_PREFIX}${projectId}-topic-${requestId}-0`);
export const isPinaThread = (threadId: ThreadId) => PINA_THREAD_ID.test(threadId);
export const isNamedPinaConversation = (threadId: ThreadId) =>
  isPinaThread(threadId) && /-topic-[0-9a-f-]{36}-0$/i.test(threadId);

export const OpenPinaInput = Schema.Struct({
  newConversation: Schema.optionalKey(
    Schema.Struct({
      title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      requestId: Schema.String.check(Schema.isUUID(4)),
    }),
  ),
});
export type OpenPinaInput = typeof OpenPinaInput.Type;

export function reportsTurnsToPina(
  thread: Pick<
    OrchestrationV2AppThread,
    "id" | "createdBy" | "lineage" | "delegatedFrom" | "linkOrigin" | "workflowRun"
  >,
  turnAuthor?: OrchestrationV2Actor,
) {
  return (
    (thread.createdBy === "user" || (thread.createdBy === "agent" && turnAuthor === "user")) &&
    !isPinaThread(thread.id) &&
    !thread.lineage.sideChat &&
    !thread.lineage.workflowStep &&
    (thread.lineage.relationshipToParent === null ||
      thread.lineage.relationshipToParent === "fork") &&
    !thread.delegatedFrom &&
    !thread.linkOrigin &&
    !thread.workflowRun
  );
}
