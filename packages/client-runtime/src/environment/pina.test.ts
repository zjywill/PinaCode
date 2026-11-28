import { EnvironmentId, pinaThreadId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  threadContextRecord,
} from "@t3tools/shared/composerContextReferences";
import { expect, it } from "vite-plus/test";

import { resolvePinaEnvironment, updatePinaComposerDraft } from "./pina.ts";
import { scopeThreadRef } from "./scoped.ts";

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

it("replaces and clears only the automatic reference when entering Pina", () => {
  const pina = scopeThreadRef(local, pinaThreadId(ProjectId.make("scratch"), 0));
  const source = { ref: scopeThreadRef(local, ThreadId.make("login")), title: "Login" };
  const nextSource = { ref: scopeThreadRef(local, ThreadId.make("billing")), title: "Billing" };
  const manual = threadContextRecord(scopeThreadRef(local, ThreadId.make("docs")), "Docs");
  const draft = {
    text: `Check ${formatComposerContextReference(manual)} too.\n`,
    records: [manual],
  };

  const opened = updatePinaComposerDraft(pina, source, draft)!;
  expect(opened.records).toMatchObject([manual, { title: "Login", threadId: source.ref.threadId }]);
  expect(opened.text).toBe(`${formatComposerContextReference(opened.records[1]!)} ${draft.text}`);
  expect(updatePinaComposerDraft(pina, source, opened)).toEqual(opened);
  expect(updatePinaComposerDraft(pina, { ref: pina, title: "Pina" }, opened)).toBeNull();

  const reopened = updatePinaComposerDraft(pina, nextSource, opened)!;
  expect(reopened.records).toMatchObject([
    manual,
    { title: "Billing", threadId: nextSource.ref.threadId },
  ]);
  expect(reopened.text).toBe(
    `${formatComposerContextReference(reopened.records[1]!)} ${draft.text}`,
  );
  expect(updatePinaComposerDraft(pina, null, reopened)).toEqual(draft);
  expect(
    updatePinaComposerDraft(
      pina,
      { ref: scopeThreadRef(remote, source.ref.threadId), title: source.title },
      reopened,
    ),
  ).toEqual(draft);
  expect(
    updatePinaComposerDraft(
      pina,
      { ref: scopeThreadRef(local, manual.threadId), title: "Docs" },
      opened,
    ),
  ).toEqual(draft);
});
