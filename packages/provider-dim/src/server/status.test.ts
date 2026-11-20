import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DimSettings } from "../settings.ts";
import { checkDimProviderStatus, readDimWorkspaceSkills } from "./status.ts";
import type { DimConnection } from "./transport.ts";

const hello = {
  instanceId: "fixture",
  serverVersion: "0.1.0-alpha.26",
  protocolVersion: 4,
  daemonProfile: { kind: "product" },
  features: ["provider.models.query", "skills.catalog"],
} as const;

const settings = Schema.decodeSync(DimSettings)({
  enabled: true,
  binaryPath: process.execPath,
});

const connection = (request: DimConnection["request"]): DimConnection => ({
  hello,
  request,
  notices: Stream.empty,
  closed: Effect.never,
});

it.live("lists selectable Dim models even when provider.list omits Dim OAuth", () =>
  Effect.gen(function* () {
    const modelContextWindows = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const next = { providerId: "dimcode-api-oauth", modelId: "unavailable-model" };
    const probeConnection = connection((method, params) => {
      switch (method) {
        case "provider.list":
          return Effect.succeed({ providers: [] });
        case "provider.models.query":
          assert.strictEqual(params?.selectableOnly, true);
          if (!params?.after) return Effect.succeed({ models: [], next });
          assert.deepStrictEqual(params.after, next);
          return Effect.succeed({
            models: [
              {
                providerId: "dimcode-api-oauth",
                providerName: "Dim OAuth",
                model: {
                  id: "example-model",
                  name: "Example Model",
                  capabilities: { contextWindow: 128000 },
                  unavailableReason: null,
                },
              },
            ],
            next: null,
          });
        default:
          return Effect.succeed({});
      }
    });
    const snapshot = yield* checkDimProviderStatus({
      settings,
      environment: process.env,
      modelContextWindows,
      daemon: {
        endpoint: "/fixture/dim.sock",
        nativeHome: "/fixture/rust",
        productHome: "/fixture",
        ensure: () => Effect.succeed(hello),
        connect: () => Effect.succeed(probeConnection),
      },
    });
    assert.strictEqual(snapshot.status, "ready");
    assert.deepStrictEqual(
      snapshot.models.map(({ slug, subProvider }) => [slug, subProvider]),
      [
        ["default", undefined],
        ["dimcode-api-oauth/example-model", "Dim OAuth"],
      ],
    );
    assert.strictEqual(
      (yield* Ref.get(modelContextWindows)).get("dimcode-api-oauth/example-model"),
      128000,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads workspace Skills with Dim's enablement and invocation metadata", () =>
  Effect.gen(function* () {
    const cwd = "/workspace/feature";
    const skills = yield* readDimWorkspaceSkills(
      connection((method, params) => {
        assert.strictEqual(method, "skills.catalog");
        assert.deepStrictEqual(params, { cwd });
        const entry = {
          name: "review",
          filePath: `${cwd}/.agents/skills/review/SKILL.md`,
          description: "Review changes",
          source: "project",
          enabled: true,
          userInvocable: true,
          modelInvocable: false,
          shadowedBy: null,
        };
        return Effect.succeed({
          entries: [
            entry,
            { ...entry, source: "user", shadowedBy: "workspace-review" },
            { ...entry, name: "draft", enabled: false, userInvocable: false, modelInvocable: true },
          ],
        });
      }),
      cwd,
    );
    assert.deepStrictEqual(skills, [
      {
        name: "review",
        path: `${cwd}/.agents/skills/review/SKILL.md`,
        description: "Review changes",
        scope: "project",
        enabled: true,
        userInvocable: true,
        userInvocationOnly: true,
      },
      {
        name: "draft",
        path: `${cwd}/.agents/skills/review/SKILL.md`,
        description: "Review changes",
        scope: "project",
        enabled: false,
        userInvocable: false,
      },
    ]);
  }),
);
