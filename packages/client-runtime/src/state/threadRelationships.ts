import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell, ThreadStructure } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import { scopeThreadRef, scopedThreadKey } from "../environment/scoped.ts";

export interface DelegationListRow {
  readonly depth: number;
  readonly continuations: ReadonlyArray<boolean>;
  readonly childCount: number;
  readonly taskCount: number;
  readonly expanded: boolean;
  readonly activeCount: number;
  readonly blockedCount: number;
  readonly progress: string | null;
  readonly detail: string | null;
}

/** Only visible parents group children; a filtered or missing parent never hides a task. */
export function groupDelegationList<T>(input: {
  readonly items: ReadonlyArray<T>;
  readonly threadOf: (item: T) => EnvironmentThreadShell | undefined;
  readonly sectionOf?: (item: T) => string | undefined;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly collapsed: ReadonlySet<string>;
}): { readonly items: ReadonlyArray<T>; readonly rows: ReadonlyMap<string, DelegationListRow> } {
  const keyOf = (thread: EnvironmentThreadShell) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const visible = new Map<string, T>();
  const partitions = new Map<string, number>();
  let partition = 0;
  let previousSection: string | undefined;
  for (const item of input.items) {
    const thread = input.threadOf(item);
    if (thread === undefined) {
      partition++;
      continue;
    }
    const section = input.sectionOf?.(item);
    if (section !== previousSection) partition++;
    previousSection = section;
    visible.set(keyOf(thread), item);
    partitions.set(keyOf(thread), partition);
  }
  const parentByKey = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const [key, item] of visible) {
    const thread = input.threadOf(item)!;
    if (
      thread.lineage.relationshipToParent !== "delegation" ||
      thread.lineage.parentThreadId === null
    )
      continue;
    const parentKey = scopedThreadKey(
      scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId),
    );
    if (parentKey === key || partitions.get(parentKey) !== partitions.get(key)) continue;
    parentByKey.set(key, parentKey);
    const siblings = children.get(parentKey) ?? [];
    siblings.push(key);
    children.set(parentKey, siblings);
  }
  const progress = new Map<
    string,
    { label: string; detail: string | null; active: boolean; blocked: boolean }
  >();
  for (const parent of input.threads) {
    for (const link of parent.pullRequests) {
      const watch = link.watch ?? link.endedWatch;
      const followUp = watch?.followUp;
      if (followUp === undefined) continue;
      const key = scopedThreadKey(scopeThreadRef(parent.environmentId, followUp.childThreadId));
      const terminal =
        link.snapshot?.state === "merged"
          ? "Merged"
          : link.snapshot?.state === "closed"
            ? "Closed"
            : link.watch === undefined && followUp.phase !== "paused"
              ? "Stopped"
              : null;
      const phase = followUp.phase;
      const label =
        terminal ??
        (phase === "waiting-ci"
          ? "Waiting for CI"
          : phase === "waiting-approval"
            ? "Waiting for approval"
            : phase === "awaiting-acceptance"
              ? "Awaiting coordinator acceptance"
              : phase === "unreadable"
                ? "Unable to verify"
                : phase === "paused"
                  ? "Paused"
                  : phase === "blocked"
                    ? "Blocked"
                    : "Verifying");
      const state = {
        label,
        detail: followUp.blockers?.join("; ") || null,
        active: terminal === null,
        blocked:
          terminal === null &&
          (phase === "blocked" ||
            phase === "waiting-approval" ||
            phase === "unreadable" ||
            phase === "paused"),
      };
      const previous = progress.get(key);
      // A resumed watch takes precedence over an older ended link for the same task.
      if (previous === undefined || (!previous.active && state.active)) progress.set(key, state);
    }
  }
  const totals = new Map<string, { count: number; active: number; blocked: number }>();
  for (const thread of input.threads) {
    if (
      thread.lineage.relationshipToParent !== "delegation" ||
      thread.lineage.parentThreadId === null ||
      thread.deletedAt !== null
    )
      continue;
    const key = keyOf(thread);
    const state = progress.get(key);
    const parentKey = scopedThreadKey(
      scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId),
    );
    const total = totals.get(parentKey) ?? { count: 0, active: 0, blocked: 0 };
    total.count++;
    const active = state?.active ?? thread.archivedAt === null;
    if (active) total.active++;
    if (active && (state?.blocked || thread.hasPendingApprovals || thread.hasPendingUserInput))
      total.blocked++;
    totals.set(parentKey, total);
  }
  const rows = new Map<string, DelegationListRow>();
  const items: T[] = [];
  const visited = new Set<string>();
  const visit = (key: string, continuations: ReadonlyArray<boolean>, hidden = false) => {
    if (visited.has(key)) return;
    visited.add(key);
    const item = visible.get(key)!;
    const thread = input.threadOf(item)!;
    const state = progress.get(key);
    const nested = children.get(key) ?? [];
    const expanded = !input.collapsed.has(key);
    const total = totals.get(key);
    if (!hidden) {
      items.push(item);
      if (
        nested.length > 0 ||
        total !== undefined ||
        state !== undefined ||
        thread.lineage.relationshipToParent === "delegation"
      )
        rows.set(key, {
          depth: continuations.length,
          continuations,
          childCount: nested.length,
          taskCount: total?.count ?? 0,
          expanded,
          activeCount: total?.active ?? 0,
          blockedCount: total?.blocked ?? 0,
          progress:
            state?.active !== false && thread.hasPendingApprovals
              ? "Waiting for permission"
              : state?.active !== false && thread.hasPendingUserInput
                ? "Waiting for input"
                : state?.active && isThreadWorking(thread)
                  ? "Repairing"
                  : (state?.label ?? null),
          detail: state?.detail ?? null,
        });
    }
    for (const [index, child] of nested.entries())
      visit(child, [...continuations, index < nested.length - 1], hidden || !expanded);
  };
  for (const item of input.items) {
    const thread = input.threadOf(item);
    if (thread === undefined) items.push(item);
    else if (!parentByKey.has(keyOf(thread))) visit(keyOf(thread), []);
  }
  // Malformed legacy cycles must remain navigable too.
  for (const key of visible.keys()) if (!visited.has(key)) visit(key, []);
  return { items, rows };
}

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "delegation" | "transfer";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<ThreadStructure, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: ThreadStructure | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent ?? "fork",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: child?.lineage.relationshipToParent === "delegation" ? "delegation" : "subagent",
        status:
          child?.activityRunStatus ??
          (child?.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
            ? child.status
            : subagent.status),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return edge.kind !== "transfer" && edge.targetThreadId === currentThreadId;
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}
