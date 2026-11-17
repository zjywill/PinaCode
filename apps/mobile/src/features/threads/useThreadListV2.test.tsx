import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import type { OlderSettledShelfEnvironment } from "@t3tools/client-runtime/state/threads";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { olderSettledThreads } from "../../state/threads";
import { makeRawThreadShell } from "../../test-fixtures";
import { useThreadListV2 } from "./useThreadListV2";

vi.mock("../../state/threads", () => ({
  olderSettledThreads: { shelfAtom: vi.fn() },
  threadFamilies: { mountRows: () => () => {} },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: undefined }));

it("reuses a large thread list across tab renders and updates when its inputs change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  using _globals = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  const shelfAtom = Atom.make<ReadonlyMap<EnvironmentId, OlderSettledShelfEnvironment>>(new Map());
  vi.mocked(olderSettledThreads.shelfAtom).mockReturnValue(shelfAtom);
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const environmentId = EnvironmentId.make("environment-1");
  const otherEnvironmentId = EnvironmentId.make("environment-2");
  const threads = Array.from({ length: 1200 }, (_, index) =>
    presentThreadShell(
      index % 2 === 0 ? environmentId : otherEnvironmentId,
      makeRawThreadShell({
        id: ThreadId.make(`thread-${index}`),
        title: `Thread ${index}`,
        settledOverride: index < 150 ? "active" : "settled",
        settledAt: index < 150 ? null : DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      }),
    ),
  );
  const environmentIds = new Set([environmentId, otherEnvironmentId]);
  const input: Parameters<typeof useThreadListV2>[0] = {
    threads,
    pendingTasks: [],
    environmentId: null,
    projectRefs: null,
    searchQuery: "",
    searchMatches: new Map(),
    settlementEnvironmentIds: environmentIds,
    snoozeEnvironmentIds: environmentIds,
    pinReorderEnvironmentIds: environmentIds,
    activeReorderEnvironmentIds: environmentIds,
    queuedThreadKeys: new Set(),
    settledLimit: 10,
    now: "2026-01-02T00:00:00.000Z",
    pendingOrder: null,
    shelfPreferencesLoaded: true,
    workingShelfEnabled: true,
    workingShelfExpanded: false,
    snoozedShelfExpanded: false,
    settledShelfExpanded: true,
    selectedThreadKey: null,
  };
  const seen: Array<ReturnType<typeof useThreadListV2>> = [];
  function Probe(props: { input: typeof input; tab: string }) {
    return (
      <RegistryContext value={registry}>
        <ListProbe {...props} />
      </RegistryContext>
    );
  }
  function ListProbe(props: { input: typeof input; tab: string }) {
    const result = useThreadListV2(props.input);
    useLayoutEffect(() => {
      seen.push(result);
    });
    return <div>{props.tab}</div>;
  }

  const root = createRoot(document.createElement("div"));
  using _root = { [Symbol.dispose]: () => act(() => root.unmount()) };
  await act(async () => root.render(<Probe input={{ ...input }} tab="chats" />));
  const initial = seen.at(-1)!;
  expect(initial.layout.items).toHaveLength(160);
  expect(initial.layout.settledCount).toBe(1050);

  for (const tab of ["pullRequests", "chats", "settings", "chats"]) {
    await act(async () => root.render(<Probe input={{ ...input }} tab={tab} />));
    expect(seen.at(-1)!.olderSettledShelf.isListed).toBe(initial.olderSettledShelf.isListed);
    expect(seen.at(-1)!.olderSettledShelf.unloadedCount).toBe(
      initial.olderSettledShelf.unloadedCount,
    );
    expect(seen.at(-1)!.layout).toBe(initial.layout);
    expect(seen.at(-1)!.items).toBe(initial.items);
  }

  const nextMinute = { ...input, now: "2026-01-02T00:01:00.000Z" };
  await act(async () => root.render(<Probe input={nextMinute} tab="chats" />));
  expect(seen.at(-1)!.layout).toBe(initial.layout);
  expect(seen.at(-1)!.items).not.toBe(initial.items);
  expect(seen.at(-1)!.items.find((item) => item.type === "v2-thread")).toMatchObject({
    snoozePresetMinute: nextMinute.now,
  });

  await act(async () => root.render(<Probe input={{ ...input, environmentId }} tab="chats" />));
  expect(seen.at(-1)!.layout.items).toHaveLength(85);
  expect(seen.at(-1)!.layout.settledCount).toBe(525);
  expect(
    seen.at(-1)!.layout.items.every((item) => item.thread.environmentId === environmentId),
  ).toBe(true);

  const queuedThreadKeys = new Set([`${environmentId}:thread-150`]);
  await act(async () => root.render(<Probe input={{ ...input, queuedThreadKeys }} tab="chats" />));
  const queued = seen.at(-1)!;
  expect(queued.layout.items).toHaveLength(161);
  expect(queued.layout.settledCount).toBe(1049);
  expect(
    queued.items.find((item) => item.type === "v2-thread" && item.item.thread.id === "thread-150"),
  ).toMatchObject({ hasQueuedMessages: true, item: { variant: "card" } });

  await act(async () => root.render(<Probe input={{ ...input, settledLimit: 35 }} tab="chats" />));
  expect(seen.at(-1)!.layout.items).toHaveLength(185);

  const updatedThreads = threads.map((thread) =>
    thread.id === "thread-0" ? { ...thread, title: "Updated title" } : thread,
  );
  await act(async () =>
    root.render(<Probe input={{ ...input, threads: updatedThreads }} tab="chats" />),
  );
  expect(
    seen.at(-1)!.layout.items.find((item) => item.thread.id === "thread-0")?.thread.title,
  ).toBe("Updated title");

  await act(async () =>
    root.render(
      <Probe
        input={{ ...input, threads: updatedThreads, searchQuery: "Updated title" }}
        tab="chats"
      />,
    ),
  );
  expect(seen.at(-1)!.layout.items.map((item) => item.thread.title)).toEqual(["Updated title"]);
  const search = seen.at(-1)!;
  await act(async () =>
    root.render(
      <Probe
        input={{ ...nextMinute, threads: updatedThreads, searchQuery: "Updated title" }}
        tab="chats"
      />,
    ),
  );
  expect(seen.at(-1)!.layout).not.toBe(search.layout);
  expect(seen.at(-1)!.layout.items.map((item) => item.thread.title)).toEqual(["Updated title"]);

  const clockThreads = threads.map((thread) =>
    thread.id === "thread-0" ? { ...thread, snoozedUntil: "2026-01-02T00:00:30.000Z" } : thread,
  );
  const clockInput = { ...input, threads: clockThreads, snoozedShelfExpanded: true };
  await act(async () => root.render(<Probe input={clockInput} tab="chats" />));
  const beforeClock = seen.at(-1)!;
  expect(beforeClock.layout.snoozedCount).toBe(1);
  expect(beforeClock.layout.items.find((item) => item.thread.id === "thread-0")?.snoozed).toBe(
    true,
  );
  await act(async () => root.render(<Probe input={clockInput} tab="settings" />));
  expect(seen.at(-1)!.items).toBe(beforeClock.items);

  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:00:10.000Z" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout).toBe(beforeClock.layout);
  expect(seen.at(-1)!.layout.snoozedCount).toBe(1);

  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:01:00.000Z" }} tab="chats" />),
  );
  const afterClock = seen.at(-1)!;
  expect(afterClock.items).not.toBe(beforeClock.items);
  expect(afterClock.layout.snoozedCount).toBe(0);
  expect(afterClock.layout.items.find((item) => item.thread.id === "thread-0")?.snoozed).toBe(
    false,
  );
  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:02:00.000Z" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout).toBe(afterClock.layout);
  expect(seen.at(-1)!.items).not.toBe(afterClock.items);

  await act(async () =>
    root.render(<Probe input={{ ...clockInput, now: "2026-01-02T00:00:20.000Z" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout.snoozedCount).toBe(1);
  expect(seen.at(-1)!.layout.items.find((item) => item.thread.id === "thread-0")?.snoozed).toBe(
    true,
  );
  await act(async () => root.render(<Probe input={input} tab="chats" />));
  const before = "2026-01-01T12:00:00.000Z";
  const older = {
    before,
    beforeMs: Date.parse(before),
    counts: new Map([[ProjectId.make("project-test"), 575]]),
  };
  await act(async () => {
    registry.set(
      shelfAtom,
      new Map([
        [
          environmentId,
          {
            older,
            pages: { reads: [], frontier: { settledAt: before }, status: "pending" },
          },
        ],
      ]),
    );
  });
  const loading = seen.at(-1)!;
  expect(loading.layout.settledCount).toBe(1100);
  expect(loading.layout.listedSettledThreads).toHaveLength(0);
  expect(loading.layout.items).toHaveLength(150);
  expect(loading.olderSettledShelf.isListed(threads[150]!)).toBe(false);
  await act(async () => root.render(<Probe input={input} tab="settings" />));
  expect(seen.at(-1)!.items).toBe(loading.items);

  await act(async () => {
    registry.set(
      shelfAtom,
      new Map([
        [
          environmentId,
          {
            older,
            pages: { reads: [], frontier: null, status: "ready" },
          },
        ],
      ]),
    );
  });
  const loaded = seen.at(-1)!;
  expect(loaded.layout.settledCount).toBe(1100);
  expect(loaded.layout.items).toHaveLength(160);
  expect(loaded.olderSettledShelf.isListed(threads[150]!)).toBe(true);
  expect(loaded.items).not.toBe(loading.items);

  const parent = {
    ...threads[0]!,
    id: ThreadId.make("review-parent"),
    title: "Shared search parent",
    lineage: {
      rootThreadId: ThreadId.make("review-parent"),
      parentThreadId: null,
      relationshipToParent: null,
    },
  };
  const child = {
    ...parent,
    id: ThreadId.make("review-child"),
    title: "Shared search child",
    lineage: {
      rootThreadId: parent.id,
      parentThreadId: parent.id,
      relationshipToParent: "delegation" as const,
    },
  };
  const reviewInput = {
    ...input,
    threads: [child, parent],
    workingShelfEnabled: false,
    settledShelfExpanded: false,
  };
  await act(async () => root.render(<Probe input={reviewInput} tab="chats" />));
  await act(async () => seen.at(-1)!.toggleDelegation(`${environmentId}:${parent.id}`));
  await act(async () =>
    root.render(<Probe input={{ ...reviewInput, searchQuery: "Shared search" }} tab="chats" />),
  );
  expect(seen.at(-1)!.layout.items).toHaveLength(2);
  expect
    .soft(
      seen
        .at(-1)!
        .items.filter((item) => item.type === "v2-thread")
        .map((item) => item.item.thread.id)
        .sort(),
      "search must retain both matching sessions despite an earlier parent collapse",
    )
    .toEqual([child.id, parent.id].sort());

  await act(async () => seen.at(-1)!.toggleDelegation(`${environmentId}:${parent.id}`));
  await act(async () =>
    root.render(
      <Probe
        input={{ ...reviewInput, threads: [{ ...child, pinnedAt: input.now }, parent] }}
        tab="chats"
      />,
    ),
  );
  expect(seen.at(-1)!.layout.items.map((item) => item.thread.id)).toEqual([child.id, parent.id]);
  expect
    .soft(
      seen
        .at(-1)!
        .items.filter((item) => item.type === "v2-thread")
        .map((item) => item.item.thread.id),
      "pinned child must remain ahead of the unpinned parent",
    )
    .toEqual([child.id, parent.id]);
});
