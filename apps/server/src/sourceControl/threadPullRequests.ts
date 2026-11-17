import type { ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";
import { makeThreadPullRequests } from "@t3tools/source-control-core/shared/threadPullRequests";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadPullRequestChains,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlDefinitions);

export function parentOwnsPullRequestFollowUp(
  links: ReadonlyArray<ThreadPullRequestLink>,
  childThreadId: ThreadId,
  target: Pick<ThreadPullRequestLink, "host" | "repository" | "number">,
): boolean {
  return links.some((link) => {
    const watch =
      link.watch ?? (link.endedWatch?.followUp?.phase === "paused" ? link.endedWatch : undefined);
    return (
      link.source !== "stack-dismissed" &&
      threadPullRequestKeysEqual(link, target) &&
      watch?.followUp?.childThreadId === childThreadId
    );
  });
}
