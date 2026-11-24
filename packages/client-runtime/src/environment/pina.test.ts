import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { pinaThreadSource, resolvePinaEnvironment } from "./pina.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const offline = EnvironmentId.make("offline");
const supported: {
  environment: { capabilities: { pinaAssistant: boolean } };
  scratchWorkspaceRoot?: string;
} = {
  environment: { capabilities: { pinaAssistant: true } },
  scratchWorkspaceRoot: "/scratch",
};
const input = {
  requested: null,
  preferred: local,
  connected: [local, remote],
  permitted: new Set([local, remote, offline]),
  configs: new Map([
    [local, supported],
    [remote, supported],
    [offline, supported],
  ]),
};

it("honors an explicit machine and otherwise prefers the available default", () => {
  expect(resolvePinaEnvironment(input)).toBe(local);
  expect(resolvePinaEnvironment({ ...input, requested: remote })).toBe(remote);
});

it("falls back only when no machine was explicitly selected", () => {
  const unavailable = [
    { ...input, connected: [remote] },
    { ...input, permitted: new Set([remote]) },
    { ...input, configs: new Map([[remote, supported]]) },
    {
      ...input,
      configs: new Map([
        [local, { environment: supported.environment }],
        [remote, supported],
      ]),
    },
    {
      ...input,
      configs: new Map([
        [local, { ...supported, environment: { capabilities: { pinaAssistant: false } } }],
        [remote, supported],
      ]),
    },
  ];
  for (const settings of unavailable) {
    expect(resolvePinaEnvironment(settings)).toBe(remote);
    expect(resolvePinaEnvironment({ ...settings, requested: local })).toBeNull();
  }
  expect(resolvePinaEnvironment({ ...input, preferred: offline })).toBe(local);
  expect(resolvePinaEnvironment({ ...input, permitted: new Set() })).toBeNull();
});

it("keeps the exact open thread reference when the sidebar has not loaded its title", () => {
  const threadId = ThreadId.make("side-chat");
  const ref = { environmentId: remote, threadId };
  expect(pinaThreadSource(ref, null)).toEqual({
    environmentId: remote,
    id: threadId,
    title: threadId,
  });
  expect(pinaThreadSource(ref, { title: "Implementation notes" })?.title).toBe(
    "Implementation notes",
  );
  expect(pinaThreadSource(null, null)).toBeNull();
});
