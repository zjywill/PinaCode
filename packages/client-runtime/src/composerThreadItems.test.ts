import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    projectId: ProjectId.make("alpha"),
    settledOverride: null,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("lists unsettled threads in Pina and resolves project searches to individual thread refs", () => {
  const remote = EnvironmentId.make("linked");
  const pina = ThreadId.make("pina-assistant-scratch-0");
  const input = {
    environmentId,
    linkedEnvironments: new Map([[remote, "Laptop"]]),
    excludeThreadId: pina,
    now: Date.parse("2026-10-23T00:00:00Z"),
    pinaProjects: [
      { environmentId, id: ProjectId.make("alpha"), title: "Storefront" },
      { environmentId: remote, id: ProjectId.make("alpha"), title: "Inventory" },
    ],
    shells: [
      shell("local", "Review", { latestUserMessageAt: "2026-10-22T00:00:00Z" }),
      shell("remote", "Review", { environmentId: remote }),
      shell("settled", "Review", { settledOverride: "settled" }),
      shell("archived", "Review", { archivedAt: "2026-10-21T00:00:00Z" }),
      shell("other", "Review", { environmentId: EnvironmentId.make("unlinked") }),
      shell(pina, "Pina"),
      shell("pina-assistant-scratch-1", "Pina", { environmentId: remote }),
    ],
  };
  const items = (query: string) => matchComposerThreadItems({ ...input, query });
  expect(items("").map(({ label, description }) => [label, description])).toEqual([
    ["Review", "Storefront"],
    ["Review", "Inventory · Laptop"],
  ]);
  expect(items("inventory").map((item) => item.thread)).toEqual([
    { environmentId: remote, threadId: "remote" },
  ]);
  expect(items("review")).toHaveLength(2);
  expect(matchComposerThreadItems({ ...input, pinaProjects: [], query: "" })).toHaveLength(2);
  const { pinaProjects: _projects, ...ordinary } = input;
  expect(matchComposerThreadItems({ ...ordinary, excludeThreadId: null, query: "" })).toEqual([]);
});

it("offers the composer thread's own used side chats, but not other threads' side chats", () => {
  const sideChatOf = (parent: string) => ({
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "fork" as const,
    sideChat: true,
  });
  const latestUserMessageAt = "2026-10-22T00:00:00.000Z";
  const items = matchComposerThreadItems({
    shells: [
      shell("mine", "Why is the build slow?", { lineage: sideChatOf("main"), latestUserMessageAt }),
      shell("unused", "Slow side chat", { lineage: sideChatOf("main") }),
      shell("theirs", "Why is the test slow?", {
        lineage: sideChatOf("other"),
        latestUserMessageAt,
      }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: ThreadId.make("main"),
    query: "slow",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, description }) => ({ id: thread.threadId, description }))).toEqual([
    { id: "mine", description: "Side chat" },
  ]);
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", { environmentId: vps }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    { thread: { environmentId, threadId: "here" }, label: "Deploy script", description: "Thread" },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Thread on Hetzner VPS",
    },
  ]);
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });

  it("offers machines the composer's environment links to that this client is not paired with", () => {
    expect(
      matchComposerEnvironmentItems({
        environments: [],
        linkedEnvironments: new Map([
          [EnvironmentId.make("env-here"), "Laptop"],
          [EnvironmentId.make("env-build"), "buildbox"],
        ]),
        environmentId: EnvironmentId.make("env-here"),
        query: "build",
      }),
    ).toEqual([
      {
        id: "environment:env-build",
        type: "environment",
        environmentId: "env-build",
        machine: "server",
        label: "buildbox",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map([[EnvironmentId.make("env-vps"), "Hetzner VPS"]]),
        environmentId: EnvironmentId.make("env-here"),
        query: "vps",
      }).map((item) => item.machine),
    ).toEqual(["cloud"]);
  });
});
