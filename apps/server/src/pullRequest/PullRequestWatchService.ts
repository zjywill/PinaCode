import {
  CommandId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PullRequestUnavailableError,
  type PullRequestFollowUp,
  type PullRequestWatchUntil,
  type PullRequestWorkflowState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "./PullRequestService.ts";
import {
  resolveTarget,
  type PullRequestTarget,
  type PullRequestTargetError,
  type ResolvedTarget,
} from "./pullRequestTarget.ts";
import {
  parentOwnsPullRequestFollowUp,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";

export class PullRequestWatchFailedError extends Schema.TaggedError<PullRequestWatchFailedError>()(
  "PullRequestWatchFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not change whether the pull request is watched.";
  }
}

export class PullRequestWatchFromSubagentError extends Schema.TaggedError<PullRequestWatchFromSubagentError>()(
  "PullRequestWatchFromSubagentError",
  {},
) {
  override get message(): string {
    return "This delegated session's parent owns PR monitoring and the coordinator workflow. Do the assigned work in this session and report back instead.";
  }
}

export class PullRequestWatchThreadNotFoundError extends Schema.TaggedError<PullRequestWatchThreadNotFoundError>()(
  "PullRequestWatchThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class PullRequestFollowUpInvalidError extends Schema.TaggedError<PullRequestFollowUpInvalidError>()(
  "PullRequestFollowUpInvalidError",
  { childThreadId: ThreadId },
) {
  override get message(): string {
    return "Follow-up requires the PR to be linked to this coordinator's original independent session and worktree; an existing PR cannot be reassigned to a different session or issue.";
  }
}

export class PullRequestWatchService extends Context.Service<
  PullRequestWatchService,
  {
    readonly setWatching: (input: {
      readonly threadId: ThreadId;
      readonly target: PullRequestTarget;
      readonly watching: boolean;
      readonly followUp?: Pick<PullRequestFollowUp, "issueUrl" | "childThreadId">;
      readonly until?: PullRequestWatchUntil | undefined;
    }) => Effect.Effect<
      ResolvedTarget & {
        readonly watching: boolean;
        readonly wasWatching: boolean;
        /** Set when the PR already ended, so no watch was registered. */
        readonly state?: "merged" | "closed";
      },
      | PullRequestWatchFailedError
      | PullRequestWatchFromSubagentError
      | PullRequestWatchThreadNotFoundError
      | PullRequestTargetError
      | PullRequestUnavailableError
      | PullRequestFollowUpInvalidError
    >;
    readonly readWorkflow: (
      threadId: ThreadId,
    ) => Effect.Effect<
      PullRequestWorkflowState,
      | PullRequestWatchFailedError
      | PullRequestWatchThreadNotFoundError
      | PullRequestWatchFromSubagentError
    >;
  }
>()("pinacode/pullRequest/PullRequestWatchService") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;

  const requireThread = Effect.fn("PullRequestWatchService.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new PullRequestWatchThreadNotFoundError({ threadId });
    }
    return thread;
  });

  // Keep the registration span stable across the service extraction.
  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (input: {
    readonly threadId: ThreadId;
    readonly target: PullRequestTarget;
    readonly watching: boolean;
    readonly followUp?: Pick<PullRequestFollowUp, "issueUrl" | "childThreadId">;
    readonly until?: PullRequestWatchUntil | undefined;
  }) {
    const { watching } = input;
    const thread = yield* requireThread(input.threadId);
    const project = yield* projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })),
    );
    const target = yield* resolveTarget(input.target, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    const parent =
      watching &&
      thread.lineage.relationshipToParent === "delegation" &&
      thread.lineage.parentThreadId !== null
        ? yield* engine
            .getThreadShell(thread.lineage.parentThreadId)
            .pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })))
        : null;
    if (
      watching &&
      (thread.lineage.relationshipToParent === "subagent" ||
        parentOwnsPullRequestFollowUp(parent?.pullRequests ?? [], thread.id, target))
    ) {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    if (watching && input.followUp !== undefined) {
      const child = yield* requireThread(input.followUp.childThreadId);
      const previous = (before?.watch ?? before?.endedWatch)?.followUp;
      if (
        child.lineage.relationshipToParent !== "delegation" ||
        child.lineage.parentThreadId !== thread.id ||
        child.projectId !== thread.projectId ||
        child.worktreePath === null ||
        child.archivedAt !== null ||
        watchedLink(child) === undefined ||
        (previous !== undefined &&
          (previous.childThreadId !== child.id || previous.issueUrl !== input.followUp.issueUrl))
      )
        return yield* new PullRequestFollowUpInvalidError({ childThreadId: child.id });
    }
    const wasWatching = before?.watch !== undefined;
    // A watch on an ended PR could only report that it ended, so report it now instead.
    const alreadyEnded = (state: "merged" | "closed") => ({
      ...target,
      watching: false,
      wasWatching,
      state,
    });
    // A closed snapshot still gets a read below, since the PR may have reopened.
    if (watching && before?.snapshot?.state === "merged") return alreadyEnded("merged");
    // A pending rollup has no failure yet, so any failure the first read finds is news.
    let checksPendingAtStart: boolean | undefined;
    if (watching && !wasWatching) {
      const read = yield* pullRequests
        .summary(
          {
            projectId: thread.projectId,
            host: target.host,
            repository: target.repository,
            number: target.number,
            allowStale: false,
          },
          { recoverTransientFailure: false, bypassCache: true },
        )
        .pipe(
          Effect.catchTags({
            // Host and transport errors can recover while the watch is active.
            // A failed read leaves the seed to the link's last sync.
            PullRequestOperationError: () => Effect.undefined,
          }),
        );
      if (read?.state === "merged" || read?.state === "closed") return alreadyEnded(read.state);
      checksPendingAtStart = read === undefined ? undefined : read.checksState === "pending";
    }
    const uuid = yield* random.uuidV4().pipe(Effect.orDie);
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make(`server:mcp-pr-watch:${thread.id}:${uuid}`),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(input.followUp === undefined ? {} : { followUp: input.followUp }),
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
        ...(watching && input.until !== undefined && { until: input.until }),
        ...(watching && checksPendingAtStart !== undefined
          ? { checksPending: checksPendingAtStart }
          : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new PullRequestWatchFailedError({ cause })),
        ),
      );
    const after = yield* requireThread(thread.id);
    return {
      ...target,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching,
    };
  });

  const readWorkflow = Effect.fn("PullRequestWatchService.readWorkflow")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* requireThread(threadId);
    if (
      thread.lineage.relationshipToParent === "subagent" ||
      thread.lineage.relationshipToParent === "delegation"
    ) {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const { subagents } = yield* engine
      .getThreadRecords(threadId, ["subagents"])
      .pipe(Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })));
    const followUps = threadPullRequestsOf(thread).map(
      (link) => (link.watch ?? link.endedWatch)?.followUp,
    );
    const sessions = yield* Effect.forEach(
      [
        ...new Map(
          subagents
            .map((task) => ({
              ...task,
              issueUrl:
                task.issueUrl ??
                followUps.find((binding) => binding?.childThreadId === task.childThreadId)
                  ?.issueUrl,
            }))
            .filter((task) => task.childThreadId !== null)
            .map((task) => [task.childThreadId, task]),
        ).values(),
      ],
      (task) =>
        engine.getThreadShell(task.childThreadId!).pipe(
          Effect.mapError((cause) => new PullRequestWatchFailedError({ cause })),
          Effect.map((child) =>
            task.issueUrl === undefined && child?.lineage.relationshipToParent !== "delegation"
              ? null
              : {
                  issueUrl: task.issueUrl ?? null,
                  childThreadId: task.childThreadId!,
                  worktreePath: child?.worktreePath ?? null,
                  providerInstanceId: child?.providerInstanceId ?? task.providerInstanceId,
                  model: child?.modelSelection.model ?? task.model,
                  status:
                    child?.deletedAt != null
                      ? "deleted"
                      : child?.archivedAt != null
                        ? "archived"
                        : (child?.status ?? "unavailable"),
                },
          ),
        ),
      { concurrency: 4 },
    );
    return {
      sessions: sessions.filter((session) => session !== null),
      pullRequests: threadPullRequestsOf(thread),
    };
  });

  return PullRequestWatchService.of({ setWatching, readWorkflow });
});

export const layer = Layer.effect(PullRequestWatchService, make);
