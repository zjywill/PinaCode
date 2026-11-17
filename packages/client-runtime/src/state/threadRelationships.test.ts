import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId, type PullRequestFollowUp } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

import {
  deriveThreadRelationshipGraph,
  groupDelegationList,
  immediateThreadRelationships,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  threadRelationshipRowStatus,
} from "./threadRelationships.ts";

describe("thread relationships", () => {
  it("groups independent sessions without hiding filtered parents' children or changing watches", () => {
    const environment = EnvironmentId.make("local");
    const shell = (id: string, parent: string | null = null) =>
      presentThreadShell(environment, {
        ...v2ThreadShell,
        id: ThreadId.make(id),
        lineage: {
          rootThreadId: ThreadId.make(parent ?? id),
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "delegation",
        },
      });
    const child = shell("child", "parent");
    const sibling = shell("sibling", "parent");
    const otherEnvironmentChild = {
      ...shell("child", "parent"),
      environmentId: EnvironmentId.make("remote"),
    };
    const parent = {
      ...shell("parent"),
      pullRequests: [
        {
          host: "github.com",
          repository: "owner/repo",
          number: 1,
          url: "https://github.com/owner/repo/pull/1",
          source: "agent" as const,
          linkedAt: "2026-06-20T00:00:00.000Z",
          snapshot: null,
          stack: null,
          watch: {
            startedAt: "2026-06-20T00:00:00.000Z",
            headSha: "head",
            failedChecks: [],
            passed: true,
            passedChecks: ["test"],
            remarksThrough: "2026-06-20T00:00:00.000Z",
            remarkIds: [],
            conflicting: false,
            wakes: 0,
            followUp: {
              issueUrl: "https://github.com/owner/repo/issues/2",
              childThreadId: child.id,
              phase: "waiting-approval" as PullRequestFollowUp["phase"],
              blockers: ["Independent approval required"],
            },
          },
        },
      ],
    };
    const threads = [child, otherEnvironmentChild, parent, sibling];
    const group = (items = threads, collapsed = new Set<string>()) =>
      groupDelegationList({ items, threadOf: (thread) => thread, threads, collapsed });
    const opened = group();
    expect(opened.items.map((thread) => `${thread.environmentId}:${thread.id}`)).toEqual([
      "remote:child",
      "local:parent",
      "local:child",
      "local:sibling",
    ]);
    expect(opened.rows.get("local:parent")).toMatchObject({
      childCount: 2,
      activeCount: 2,
      blockedCount: 1,
    });
    expect(opened.rows.get("local:child")).toMatchObject({
      depth: 1,
      continuations: [true],
      progress: "Waiting for approval",
      detail: "Independent approval required",
    });
    expect(opened.rows.get("local:sibling")).toMatchObject({ continuations: [false] });
    const grandchild = shell("grandchild", "child");
    const nested = group([parent, child, grandchild, sibling]);
    expect(nested.rows.get("local:grandchild")).toMatchObject({
      depth: 2,
      continuations: [true, false],
    });
    expect(group([parent, child, grandchild]).rows.get("local:grandchild")).toMatchObject({
      continuations: [false, false],
    });
    const collapsed = new Set(["local:parent"]);
    expect(group(threads, collapsed).items).toEqual([otherEnvironmentChild, parent]);
    const separatedItems = [child, "shelf", parent];
    const separated = groupDelegationList({
      items: separatedItems,
      threadOf: (item) => (typeof item === "string" ? undefined : item),
      threads,
      collapsed,
    });
    expect(separated.items).toEqual(separatedItems);
    expect(separated.rows.get("local:child")?.depth).toBe(0);
    expect(group([parent], collapsed).rows.get("local:parent")).toMatchObject({
      childCount: 0,
      taskCount: 2,
      activeCount: 2,
      blockedCount: 1,
    });
    expect(group([child], collapsed).rows.get("local:child")).toMatchObject({
      depth: 0,
      progress: "Waiting for approval",
    });
    expect(parent.pullRequests[0]!.watch.followUp.phase).toBe("waiting-approval");
    parent.pullRequests[0]!.watch.followUp.phase = "awaiting-acceptance";
    parent.pullRequests[0]!.watch.followUp.blockers = [];
    expect(group().rows.get("local:parent")).toMatchObject({ activeCount: 2, blockedCount: 0 });
    expect(group().rows.get("local:child")?.progress).toBe("Awaiting coordinator acceptance");
    parent.pullRequests[0]!.watch.followUp.phase = "unreadable";
    expect(group().rows.get("local:child")?.progress).toBe("Unable to verify");
    expect(group().rows.get("local:parent")?.blockedCount).toBe(1);
    const { watch, ...link } = parent.pullRequests[0]!;
    watch.followUp.phase = "paused";
    threads[2] = { ...parent, pullRequests: [{ ...link, endedWatch: watch }] };
    expect(group().rows.get("local:child")?.progress).toBe("Paused");
    expect(group().rows.get("local:parent")).toMatchObject({ activeCount: 2, blockedCount: 1 });
    watch.followUp.phase = undefined;
    expect(group().rows.get("local:child")?.progress).toBe("Stopped");
    expect(group().rows.get("local:parent")).toMatchObject({ activeCount: 1, blockedCount: 0 });
  });

  it.each([
    ["running", "completed"],
    ["completed", "running"],
  ])("keeps parent %s independent of child %s", (parentStatus, childStatus) => {
    const parent = ThreadId.make("parent");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: parent,
          activityRunStatus: parentStatus,
          status: "cancelled",
          lineage: { parentThreadId: null },
        },
        {
          id: child,
          activityRunStatus: childStatus,
          lineage: { parentThreadId: parent, relationshipToParent: "fork" },
        },
      ] as never,
      projection: null,
    });
    expect(threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, child)[0]!)).toBe(
      parentStatus,
    );
    expect(
      threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, parent)[0]!),
    ).toBe(childStatus);
  });

  it("does not label a missing parent with its child's running status", () => {
    const parent = ThreadId.make("missing-parent");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          status: "running",
          lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
        },
      ] as never,
      projection: null,
    });
    expect(
      threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, child)[0]!),
    ).toBeNull();
  });

  it.each(["fork", "subagent", "delegation"] as const)(
    "keeps the parent edge of an opened %s omitted from the shell",
    (relationshipToParent) => {
      const parent = ThreadId.make("parent");
      const child = ThreadId.make("omitted-child");
      const projection = {
        thread: {
          id: child,
          forkedFrom:
            relationshipToParent === "fork"
              ? { type: "run", threadId: parent, runId: "source-run" }
              : null,
          lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent },
        },
        subagents: [],
        contextTransfers: [],
      } as never;
      const graph = deriveThreadRelationshipGraph({ threads: [], projection });
      expect(immediateThreadRelationships(graph, child)).toEqual([
        expect.objectContaining({
          threadId: parent,
          edge: expect.objectContaining({
            sourceThreadId: parent,
            targetThreadId: child,
            kind: relationshipToParent,
          }),
        }),
      ]);
      expect(resolveMergeBackTargetThreadId(projection)).toBe(
        relationshipToParent === "fork" ? parent : null,
      );
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          title: "Active child",
          activityRunStatus: "running",
          status: "cancelled",
          forkedFrom: { type: "run", threadId: parent, runId: "run-parent" },
          lineage: {
            rootThreadId: parent,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      ] as never,
      projection: null,
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({ targetThreadId: child, status: "running" }),
    ]);
  });

  it("keeps missing parents and cycles navigable without recursive traversal", () => {
    const root = ThreadId.make("thread-root");
    const child = ThreadId.make("thread-child");
    const missing = ThreadId.make("thread-missing");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: root,
          title: "Root",
          status: "completed",
          forkedFrom: { type: "run", threadId: child, runId: "run-cycle" },
          lineage: { rootThreadId: root, parentThreadId: child, relationshipToParent: "fork" },
        },
        {
          id: child,
          title: "Child",
          status: "completed",
          forkedFrom: { type: "run", threadId: missing, runId: "run-missing" },
          lineage: { rootThreadId: root, parentThreadId: missing, relationshipToParent: "fork" },
        },
      ] as never,
      projection: null,
    });

    expect(graph.nodes.get(missing)?.missing).toBe(true);
    expect(immediateThreadRelationships(graph, root).map(({ threadId }) => threadId)).toEqual([
      child,
    ]);
  });

  it("combines subagent and transfer edges with archived shell state", () => {
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const transferTarget = ThreadId.make("thread-transfer");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: parent,
          title: "Parent",
          status: "completed",
          archivedAt: null,
          forkedFrom: null,
          lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
        },
        {
          id: child,
          title: "Subagent",
          status: "completed",
          archivedAt: "2026-06-24T00:00:00.000Z",
          forkedFrom: null,
          lineage: {
            rootThreadId: parent,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      ] as never,
      projection: {
        thread: { id: parent },
        subagents: [{ childThreadId: child, status: "completed" }],
        contextTransfers: [
          {
            sourceThreadId: child,
            targetThreadId: transferTarget,
            status: "completed",
          },
        ],
      } as never,
    });

    expect(graph.nodes.get(child)?.thread?.archivedAt).not.toBeNull();
    expect(graph.nodes.get(transferTarget)?.missing).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceThreadId: parent,
          targetThreadId: child,
          kind: "subagent",
        }),
        expect.objectContaining({
          sourceThreadId: child,
          targetThreadId: transferTarget,
          kind: "transfer",
        }),
      ]),
    );
  });

  it("keeps the live shell when an archived snapshot contains the same thread id", () => {
    const parent = ThreadId.make("thread-parent");
    const staleParent = ThreadId.make("thread-stale-parent");
    const child = ThreadId.make("thread-child");
    const liveChild = {
      id: child,
      title: "Live child",
      status: "running",
      archivedAt: null,
      forkedFrom: { type: "run", threadId: parent, runId: "run-live" },
      lineage: {
        rootThreadId: parent,
        parentThreadId: parent,
        relationshipToParent: "fork",
      },
    } as const;
    const staleArchivedChild = {
      ...liveChild,
      title: "Stale archived child",
      status: "completed",
      archivedAt: "2026-06-24T00:00:00.000Z",
      forkedFrom: { type: "run", threadId: staleParent, runId: "run-stale" },
      lineage: {
        rootThreadId: staleParent,
        parentThreadId: staleParent,
        relationshipToParent: "fork",
      },
    } as const;

    const graph = deriveThreadRelationshipGraph({
      threads: [liveChild, staleArchivedChild] as never,
      projection: null,
    });

    expect(graph.nodes.get(child)?.thread).toMatchObject({
      title: "Live child",
      status: "running",
      archivedAt: null,
    });
    expect(graph.edges).toEqual([
      expect.objectContaining({
        sourceThreadId: parent,
        targetThreadId: child,
      }),
    ]);
    expect(graph.nodes.has(staleParent)).toBe(false);
  });

  it("resolves merge-back only for forks and prefers the recorded fork source", () => {
    const source = ThreadId.make("thread-source");
    const fallbackParent = ThreadId.make("thread-parent");
    const fork = ThreadId.make("thread-fork");

    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: { type: "run", threadId: source, runId: "run-source" },
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "fork",
          },
        },
      } as never),
    ).toBe(source);
    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: null,
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "fork",
          },
        },
      } as never),
    ).toBe(fallbackParent);
    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: null,
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "subagent",
          },
        },
      } as never),
    ).toBeNull();
  });
});

const current = ThreadId.make("thread-current");

function forkShell(input: {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly status?: string;
}) {
  return {
    id: input.id,
    title: input.id,
    status: input.status ?? "completed",
    archivedAt: null,
    forkedFrom:
      input.parentThreadId === null
        ? null
        : { type: "run", threadId: input.parentThreadId, runId: `run-${input.id}` },
    lineage: {
      rootThreadId: input.parentThreadId ?? input.id,
      parentThreadId: input.parentThreadId,
      relationshipToParent: input.parentThreadId === null ? null : "fork",
    },
    createdAt: input.createdAt === undefined ? undefined : DateTime.makeUnsafe(input.createdAt),
    updatedAt: DateTime.makeUnsafe(input.updatedAt ?? "2026-06-20T00:00:00.000Z"),
  };
}

function orderedLineageIds(input: {
  readonly threads: ReadonlyArray<unknown>;
  readonly mergeTargetThreadId?: ThreadId | null;
  readonly projection?: unknown;
}): ReadonlyArray<ThreadId> {
  const graph = deriveThreadRelationshipGraph({
    threads: input.threads as never,
    projection: (input.projection ?? null) as never,
  });
  return orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, current),
    currentThreadId: current,
    mergeTargetThreadId: input.mergeTargetThreadId ?? null,
  }).map(({ threadId }) => threadId);
}

describe("web thread lineage ordering", () => {
  it("does not reorder when related-thread activity arrives", () => {
    const first = ThreadId.make("thread-fork-a");
    const second = ThreadId.make("thread-fork-b");
    const third = ThreadId.make("thread-fork-c");
    const before = orderedLineageIds({
      threads: [
        forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
        forkShell({ id: first, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        forkShell({ id: second, parentThreadId: current, createdAt: "2026-06-03T00:00:00.000Z" }),
        forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-04T00:00:00.000Z" }),
      ],
    });

    const after = orderedLineageIds({
      threads: [
        forkShell({
          id: second,
          parentThreadId: current,
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
          status: "running",
        }),
        forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-04T00:00:00.000Z" }),
        forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
        forkShell({
          id: first,
          parentThreadId: current,
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
          status: "failed",
        }),
      ],
    });

    expect(before).toEqual([third, second, first]);
    expect(after).toEqual(before);
  });

  it("pins the parent first and a distinct merge-back target second", () => {
    const parent = ThreadId.make("thread-parent");
    const mergeTarget = ThreadId.make("thread-merge-target");
    const newestFork = ThreadId.make("thread-newest-fork");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: parent, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({
            id: current,
            parentThreadId: parent,
            createdAt: "2026-06-02T00:00:00.000Z",
          }),
          forkShell({
            id: mergeTarget,
            parentThreadId: current,
            createdAt: "2026-06-03T00:00:00.000Z",
          }),
          forkShell({
            id: newestFork,
            parentThreadId: current,
            createdAt: "2026-06-09T00:00:00.000Z",
          }),
        ],
        mergeTargetThreadId: mergeTarget,
      }),
    ).toEqual([parent, mergeTarget, newestFork]);
  });

  it("sinks missing nodes and shells without a decoded createdAt", () => {
    const missingTransfer = ThreadId.make("thread-missing-transfer");
    const undated = ThreadId.make("thread-undated-fork");
    const dated = ThreadId.make("thread-dated-fork");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({ id: undated, parentThreadId: current }),
          forkShell({ id: dated, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        ],
        projection: {
          thread: { id: current },
          subagents: [],
          contextTransfers: [
            { sourceThreadId: current, targetThreadId: missingTransfer, status: "completed" },
          ],
        },
      }),
    ).toEqual([dated, missingTransfer, undated]);
  });
});
