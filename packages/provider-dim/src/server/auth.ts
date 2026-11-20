import {
  ProviderSetupError,
  type ProviderInstanceId,
  type ServerProviderAuth,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Effect from "effect/Effect";

import type { DimDaemon } from "./daemon.ts";
import { isRecord, recordField, recordString, type DimHelloResult } from "./protocol.ts";
import type { DimConnection } from "./transport.ts";
import { DIM_USAGE_PROVIDER_ID } from "./usageLimits.ts";

const target = { providerId: DIM_USAGE_PROVIDER_ID };
const DEVICE_METHOD = "dim-device";
const SIGN_IN_FEATURES = [
  "account.status",
  "account.login.begin",
  "account.login.status",
  "account.login.cancel",
  "account.logout",
];

export function supportsDimAccount(hello: DimHelloResult): boolean {
  return (
    hello.daemonProfile.kind === "product" &&
    SIGN_IN_FEATURES.every((method) => hello.features?.includes(method))
  );
}

export const refreshDimAccountModels = (request: DimConnection["request"]) =>
  request("provider.refresh", target).pipe(Effect.asVoid);

export const readDimAuth = Effect.fn("DimAuth.readStatus")(function* (
  request: DimConnection["request"],
) {
  const reply = yield* request("account.status", target);
  const account = recordField(reply, "account");
  const email = recordString(account, "email")?.trim();
  if (isRecord(account)) {
    return {
      status: "authenticated",
      canLogout: true,
      ...(email ? { email } : {}),
    } satisfies ServerProviderAuth;
  }
  return account === null ||
    (account === undefined && recordString(reply, "credentialEpoch") !== undefined)
    ? ({ status: "unauthenticated" } satisfies ServerProviderAuth)
    : undefined;
});

function verificationUrl(reply: unknown): string | undefined {
  const value =
    recordString(reply, "verificationUriComplete") ?? recordString(reply, "verificationUri");
  if (!value || value.length > 16_384) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    return;
  }
}

export const makeDimAuth = Effect.fn("DimAuth.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly daemon: Pick<DimDaemon, "connect" | "endpoint">;
  readonly refresh: Effect.Effect<void>;
}) {
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail, cause });
  const connect = Effect.fn("DimAuth.connect")(function* (operation: string) {
    const connection = yield* options.daemon
      .connect("Pina Code Dim account")
      .pipe(
        Effect.mapError((cause) =>
          failure(operation, "Could not connect to the Dim daemon.", cause),
        ),
      );
    if (!supportsDimAccount(connection.hello)) {
      return yield* failure(operation, "This Dim daemon does not support device sign-in.");
    }
    return connection.request;
  });

  const authenticate = Effect.fn("DimAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (methodId !== DEVICE_METHOD) {
      return yield* failure("start", "This Dim sign-in method is unavailable.");
    }
    const request = yield* connect("start");
    let completed = false;
    const reply = yield* Effect.acquireRelease(
      request("account.login.begin", { ...target, directory: "https://dimagent.cn" }).pipe(
        Effect.mapError((cause) => failure("start", "Could not start Dim sign-in.", cause)),
      ),
      (reply) => {
        const attemptId = recordString(reply, "attemptId");
        return !completed && attemptId
          ? request(
              "account.login.cancel",
              { ...target, attemptId },
              { timeout: "3 seconds" },
            ).pipe(Effect.ignore)
          : Effect.void;
      },
    );
    const attemptId = recordString(reply, "attemptId");
    const userCode = recordString(reply, "userCode")?.trim();
    const url = verificationUrl(reply);
    if (!attemptId || !userCode || userCode.length > 256 || !url) {
      return yield* failure("start", "Dim returned an invalid device sign-in challenge.");
    }
    yield* context.setInteraction({ type: "deviceCode", id: DEVICE_METHOD, url, userCode });
    // The daemon polls the OAuth provider. This reads the state of its attempt.
    while (true) {
      const state = yield* request("account.login.status", { ...target, attemptId }).pipe(
        Effect.mapError((cause) => failure("verify", "Could not check Dim sign-in.", cause)),
      );
      const status = recordString(state, "status");
      if (status === "completed") break;
      if (status !== "pending") {
        return yield* failure(
          "verify",
          status === "expired"
            ? "Dim sign-in expired. Start again."
            : "Dim sign-in did not complete. Start again.",
        );
      }
      yield* Effect.sleep("1 second");
    }
    completed = true;
    yield* context.verifying;
    const auth = yield* readDimAuth(request).pipe(
      Effect.mapError((cause) => failure("verify", "Could not verify the Dim account.", cause)),
    );
    if (auth?.status !== "authenticated") {
      return yield* failure("verify", "Dim did not report a signed-in account.");
    }
    yield* refreshDimAccountModels(request).pipe(Effect.ignore);
    yield* options.refresh;
  });

  const logout = Effect.scoped(
    Effect.gen(function* () {
      const request = yield* connect("logout");
      yield* request("account.logout", target).pipe(
        Effect.mapError((cause) => failure("logout", "Could not sign out of Dim.", cause)),
      );
      yield* options.refresh;
    }),
  );

  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `dim:${options.daemon.endpoint}` },
    methods: Effect.succeed([
      { id: DEVICE_METHOD, name: "Dim account", description: null, type: "agent" },
    ]),
    defaultMethodId: DEVICE_METHOD,
    authenticate,
    logout,
  });
  return {
    ...controller,
    invalidate: (controller.invalidate ?? Effect.void).pipe(Effect.andThen(options.refresh)),
  };
});
