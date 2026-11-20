import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeDimAuth } from "./auth.ts";
import type { DimConnection } from "./transport.ts";

const instanceId = ProviderInstanceId.make("dim");
const device = {
  attemptId: "attempt",
  verificationUri: "https://fixture.invalid/device",
  userCode: "FIXTURE-CODE",
};

const makeHarness = Effect.fn("DimAuthTest.makeHarness")(function* (complete: boolean) {
  const requests: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  let refreshes = 0;
  const request: DimConnection["request"] = (method, params) =>
    Effect.sync(() => {
      requests.push({ method, params });
      switch (method) {
        case "account.login.begin":
          return device;
        case "account.login.status":
          return { status: complete ? "completed" : "pending" };
        case "account.status":
          return { credentialEpoch: "epoch", account: { email: "dim@fixture.invalid" } };
        default:
          return {};
      }
    });
  const controller = yield* makeDimAuth({
    instanceId,
    daemon: {
      endpoint: "/fixture/dim.sock",
      connect: () =>
        Effect.succeed({
          request,
          hello: {
            daemonProfile: { kind: "product" },
            serverVersion: "0.1.0-alpha.26",
            instanceId: "fixture",
            protocolVersion: 4,
            features: [
              "account.status",
              "account.login.begin",
              "account.login.status",
              "account.login.cancel",
              "account.logout",
            ],
          },
          notices: Stream.empty,
          closed: Effect.never,
        }),
    },
    refresh: Effect.sync(() => {
      refreshes++;
    }),
  });
  const phase = (phase: ProviderAuthState["phase"]) =>
    controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { controller, phase, requests, refreshes: () => refreshes };
});

it.effect("verifies the Dim account and refreshes models and usage after login and logout", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(true);
    yield* harness.controller.start("owner");
    yield* harness.phase("succeeded");
    yield* harness.controller.logout(Effect.void);

    assert.deepEqual(
      harness.requests.map(({ method }) => method),
      [
        "account.login.begin",
        "account.login.status",
        "account.status",
        "provider.refresh",
        "account.logout",
      ],
    );
    assert.strictEqual(harness.refreshes(), 2);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect("cancels the Dim daemon attempt when the client cancels sign-in", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(false);
    const flow = yield* harness.controller.start("owner");
    const waiting = yield* harness.phase("waiting");
    assert.deepEqual(waiting.interaction, {
      type: "deviceCode",
      id: "dim-device",
      url: device.verificationUri,
      userCode: device.userCode,
    });

    yield* harness.controller.cancel("owner", flow.flowId!);
    assert.deepEqual(harness.requests.at(-1), {
      method: "account.login.cancel",
      params: { providerId: "dimcode-api-oauth", attemptId: device.attemptId },
    });
    assert.strictEqual(harness.refreshes(), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);
