import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DimSettings } from "../settings.ts";
import { checkDimProviderStatus, readDimWorkspaceSkills } from "./status.ts";
import { DimTransportError, type DimConnection } from "./transport.ts";

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

const checkProductStatus = (
  request: DimConnection["request"],
  modelContextWindows: Ref.Ref<ReadonlyMap<string, number>>,
) =>
  checkDimProviderStatus({
    settings,
    environment: process.env,
    modelContextWindows,
    daemon: {
      endpoint: "/fixture/dim.sock",
      nativeHome: "/fixture/rust",
      productHome: "/fixture",
      ensure: () => Effect.succeed(hello),
      connect: () => Effect.succeed(connection(request)),
    },
  });

it.live("lists selectable Dim models even when provider.list omits Dim OAuth", () =>
  Effect.gen(function* () {
    const modelContextWindows = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const next = { providerId: "dimcode-api-oauth", modelId: "unavailable-model" };
    const snapshot = yield* checkProductStatus((method, params) => {
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
    }, modelContextWindows);
    assert.strictEqual(snapshot.status, "ready");
    assert.strictEqual(snapshot.modelsIncomplete, false);
    assert.strictEqual(snapshot.version, hello.serverVersion);
    assert.strictEqual(snapshot.installedVersion, process.versions.node);
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

it.live.each([
  ["no_models", false],
  ["unreadable", true],
  ["request_failed", true],
] as const)(
  "distinguishes a Dim catalog response of %s from a confirmed inventory",
  ([result, incomplete]) =>
    Effect.gen(function* () {
      const modelContextWindows = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      const providerId = "dimcode-api-oauth";
      const snapshot = yield* checkProductStatus((method) => {
        switch (method) {
          case "provider.list":
            return Effect.succeed({
              providers: [{ providerId, enabled: true, credentialConfigured: true }],
            });
          case "provider.models.query":
            return result === "request_failed"
              ? Effect.fail(new DimTransportError({ detail: "Fixture timeout" }))
              : Effect.succeed({
                  models: [],
                  next: null,
                  empty: [{ providerId, reason: { kind: result } }],
                });
          default:
            return Effect.succeed({});
        }
      }, modelContextWindows);
      assert.strictEqual(snapshot.auth.status, "authenticated");
      assert.strictEqual(snapshot.status, "warning");
      assert.strictEqual(snapshot.modelsIncomplete, incomplete);
      assert.deepStrictEqual(snapshot.models, []);
      assert.match(
        snapshot.message ?? "",
        incomplete ? /^Could not verify/ : /^No models are available/,
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
