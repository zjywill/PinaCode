import {
  isListedThreadLineage,
  isPinaThread,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  foldSearchQuery,
  rankSearchItems,
  scoreSearchTerms,
  scoreThreadSearch,
} from "@t3tools/shared/paletteSearch";

import { scopedProjectKey } from "./environment/scoped.ts";
import { sortThreads } from "./state/threadSort.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage" | "projectId" | "settledOverride">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent threads or other threads' side chats. The agent reads threads
 * on its own server and on the machines it links to, so candidates stay within those, and a
 * linked machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(
  input: {
    shells: ReadonlyArray<ComposerThreadCandidate>;
    /** Pina browses unsettled project threads even before a search term is entered. */
    pinaProjects?: ReadonlyArray<
      Pick<EnvironmentProject, "environmentId" | "id" | "title" | "archivedAt">
    >;
    environmentId: EnvironmentId;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    excludeThreadId: ThreadId | null;
    query: string;
    /** Recency is measured against this time. */
    now: number;
  },
  resolve: MFunctionType = mFallback,
): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  const { pinaProjects } = input;
  if (query.length === 0 && !pinaProjects) return [];
  const projectByKey =
    pinaProjects &&
    new Map(
      pinaProjects.map((project) => [
        scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
        project,
      ]),
    );
  const projectTitle = (shell: ComposerThreadCandidate) =>
    projectByKey?.get(scopedProjectKey(shell))?.title;
  // Closing an unused side chat deletes it, so only one with a message is offered.
  const isOwnSideChat = (shell: ComposerThreadCandidate) =>
    shell.lineage.sideChat === true &&
    shell.environmentId === input.environmentId &&
    shell.lineage.parentThreadId === input.excludeThreadId &&
    shell.latestUserMessageAt !== null;
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      !(shell.environmentId === input.environmentId && shell.id === input.excludeThreadId) &&
      shell.archivedAt === null &&
      (!pinaProjects ||
        (!isPinaThread(shell.id) &&
          projectByKey?.get(scopedProjectKey(shell))?.archivedAt == null &&
          (query.length > 0 || shell.settledOverride !== "settled"))) &&
      (isListedThreadLineage(shell.lineage) || (!pinaProjects && isOwnSideChat(shell))),
  );
  const matches =
    query.length === 0
      ? sortThreads(candidates, "updated_at")
      : rankSearchItems(candidates, (shell, options) =>
          scoreThreadSearch(query, threadSearchSubject(shell, projectTitle(shell)), input.now, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item);
  if (pinaProjects && query) {
    matches.sort(
      (a, b) =>
        Number(foldSearchQuery(b.title) === query) - Number(foldSearchQuery(a.title) === query) ||
        Number(a.settledOverride === "settled") - Number(b.settledOverride === "settled"),
    );
  }
  const visible = matches.slice(0, COMPOSER_THREAD_RESULT_LIMIT);
  return visible.map((shell) => {
    const machine =
      shell.environmentId === input.environmentId
        ? undefined
        : input.linkedEnvironments.get(shell.environmentId);
    const title = projectTitle(shell);
    return {
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: title
        ? [title, machine].filter(Boolean).join(" · ")
        : isOwnSideChat(shell)
          ? resolve(msg("Side chat"))
          : machine === undefined
            ? resolve(msg("Thread", { $context: "noun, search result type" }))
            : resolve(msg("Thread on {machine}", { machine })),
    };
  });
}

export interface ComposerProjectItem {
  readonly id: string;
  readonly type: "project";
  readonly project: ScopedProjectRef;
  readonly label: string;
  readonly description: string;
}

export function matchPinaProjectItems(
  projects: ReadonlyArray<
    Pick<
      EnvironmentProject,
      "environmentId" | "id" | "title" | "workspaceRoot" | "archivedAt" | "isScratch"
    >
  >,
  environmentId: EnvironmentId,
  linkedEnvironments: ReadonlyMap<EnvironmentId, string>,
  query: string,
  resolve: MFunctionType = mFallback,
): ComposerProjectItem[] {
  const search = foldSearchQuery(query);
  const candidates = projects
    .filter(
      (project) =>
        !project.isScratch &&
        project.archivedAt == null &&
        (project.environmentId === environmentId || linkedEnvironments.has(project.environmentId)),
    )
    .sort(
      (a, b) =>
        Number(b.environmentId === environmentId) - Number(a.environmentId === environmentId) ||
        a.title.localeCompare(b.title) ||
        a.workspaceRoot.localeCompare(b.workspaceRoot) ||
        a.environmentId.localeCompare(b.environmentId),
    );
  const matches = search
    ? rankSearchItems(candidates, (project, options) =>
        scoreSearchTerms(
          search,
          [
            project.title,
            project.workspaceRoot,
            linkedEnvironments.get(project.environmentId) ?? "",
          ],
          options,
        ),
      ).map(({ item }) => item)
    : candidates;
  return matches.slice(0, COMPOSER_THREAD_RESULT_LIMIT).map((project) => {
    const ref = { environmentId: project.environmentId, projectId: project.id };
    const machine =
      project.environmentId === environmentId
        ? undefined
        : linkedEnvironments.get(project.environmentId);
    return {
      id: `project:${scopedProjectKey(ref)}`,
      type: "project",
      project: ref,
      label: resolve(msg("New thread in {project}", { project: project.title })),
      description: [machine, project.workspaceRoot].filter(Boolean).join(" · "),
    };
  });
}

export function composerProjectPrompt(item: ComposerProjectItem) {
  return `${item.label} (projectId: ${item.project.projectId}, environmentId: ${item.project.environmentId}) `;
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The machines the `@` picker offers, so the agent can link or work there: the client's paired
 * machines and those the composer's environment links to. The composer's own environment is
 * left out. Like threads, they need a query: bare `@` stays a file picker.
 */
export function matchComposerEnvironmentItems(
  input: {
    environments: ReadonlyArray<ComposerEnvironmentCandidate>;
    /** The machines the composer's environment links to, by name. */
    linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
    environmentId: EnvironmentId;
    query: string;
  },
  resolve: MFunctionType = mFallback,
): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const paired = new Set(input.environments.map((environment) => environment.environmentId));
  const linkedOnly = Array.from(input.linkedEnvironments, ([environmentId, label]) => ({
    environmentId,
    label,
    machine: "server" as const,
  })).filter((environment) => !paired.has(environment.environmentId));
  return [...input.environments, ...linkedOnly]
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: resolve(msg("Machine", { $context: "noun, search result type" })),
    }));
}
