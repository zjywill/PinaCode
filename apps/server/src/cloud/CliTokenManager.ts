// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cloudCliOAuthConfig, type CloudCliOAuthConfig } from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const OAUTH_REQUEST_TIMEOUT = Duration.seconds(10);
const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
  identity: Schema.optional(Schema.String),
});
export type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownEffect(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
});

const OAuthRefreshErrorCode = Schema.Literals([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_request",
  "invalid_scope",
  "access_denied",
]);
const decodeOAuthRefreshErrorResponse = Schema.decodeUnknownOption(
  Schema.Struct({ error: OAuthRefreshErrorCode }),
);

const isPermanentRefreshStatus = (status: number): boolean =>
  status >= 400 && status < 500 && status !== 408 && status !== 429;

const OidcIdentityClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.optional(Schema.String),
    preferred_username: Schema.optional(Schema.String),
    sub: Schema.optional(Schema.String),
  }),
);
const decodeOidcIdentityClaimsJson = Schema.decodeUnknownOption(OidcIdentityClaimsJson);

function idTokenIdentity(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  const decoded = Base64Url.decodeString(payload);
  if (decoded._tag !== "Success") return null;
  const claims = decodeOidcIdentityClaimsJson(decoded.success);
  if (Option.isNone(claims)) return null;
  for (const value of [claims.value.email, claims.value.preferred_username, claims.value.sub]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export class CloudCliCredentialRemovalError extends Schema.TaggedError<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedError<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  {
    cause: Schema.Defect(),
    status: Schema.optional(Schema.Number),
    oauthErrorCode: Schema.optional(OAuthRefreshErrorCode),
  },
) {
  get requiresLogin(): boolean {
    return this.status !== undefined && isPermanentRefreshStatus(this.status);
  }

  override get message(): string {
    return this.requiresLogin
      ? `Could not refresh the T3 Connect CLI credential${
          this.oauthErrorCode === undefined ? "" : ` (OAuth error: ${this.oauthErrorCode})`
        }.`
      : "Could not refresh the T3 Connect CLI credential.";
  }
}

export const isCloudCliCredentialRefreshError = Schema.is(CloudCliCredentialRefreshError);

export class CloudCliCredentialReadError extends Schema.TaggedError<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("pinacode/cloud/CliTokenManager/CloudCliTokenManager") {}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const readTokenResponse = Effect.fn("cloud.cli_token.read_token_response")(function* (
  response: HttpClientResponse.HttpClientResponse,
  params: Record<string, string>,
) {
  const body = yield* HttpClientResponse.schemaBodyJson(OAuthTokenResponse)(response);
  const now = yield* Clock.currentTimeMillis;
  const identity = idTokenIdentity(body.id_token);
  return {
    token: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + body.expires_in * 1_000,
      ...(identity === null ? {} : { identity }),
    } satisfies PersistedToken,
    identity,
  };
});

const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
  metadata: Pick<CloudCliOAuthConfig, "tokenEndpoint">,
  params: Record<string, string>,
) {
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const startedAt = yield* Clock.monotonicTimeNanos;
  return yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
    HttpClientRequest.bodyUrlParams(params),
    httpClient.execute,
    Effect.flatMap((response) => readTokenResponse(response, params)),
    Effect.timeout(OAUTH_REQUEST_TIMEOUT),
    Effect.catchTags({
      // The enclosing operation owns the span for this inline handler.
      HttpClientError: Effect.fnUntraced(function* (cause) {
        const reason = cause.reason;
        if (
          params.grant_type !== "refresh_token" ||
          reason._tag !== "StatusCodeError" ||
          !isPermanentRefreshStatus(reason.response.status)
        ) {
          return yield* cause;
        }
        // Reading a rejection body shares the exchange budget without losing
        // the known status when the body stalls or cannot be decoded.
        const elapsed = Duration.toMillis(
          Duration.nanos((yield* Clock.monotonicTimeNanos) - startedAt),
        );
        const body = yield* reason.response.json.pipe(
          Effect.timeout(Math.max(0, Duration.toMillis(OAUTH_REQUEST_TIMEOUT) - elapsed)),
          Effect.mapError(
            (cause) =>
              new CloudCliCredentialRefreshError({
                status: reason.response.status,
                cause: new HttpClientError.HttpClientError({
                  reason: new HttpClientError.StatusCodeError({
                    request: reason.request,
                    response: reason.response,
                    cause,
                  }),
                }),
              }),
          ),
        );
        const diagnostic = decodeOAuthRefreshErrorResponse(body);
        return yield* new CloudCliCredentialRefreshError({
          cause,
          status: reason.response.status,
          ...(Option.isSome(diagnostic) ? { oauthErrorCode: diagnostic.value.error } : {}),
        });
      }),
    }),
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(Effect.mapError((cause) => new CloudCliCredentialRemovalError({ cause })));

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded.value)));
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig;
    const { token: refreshed } = yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    });
    return refreshed.identity === undefined && token.identity !== undefined
      ? { ...refreshed, identity: token.identity }
      : refreshed;
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read();
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(
      // The endpoint can rotate the refresh token before shutdown interrupts us.
      // Keep the lock through persistence; the exchange still times out internally.
      yield* refresh(token.value).pipe(Effect.flatMap(persist), Effect.uninterruptible),
    );
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(
      Effect.mapError((cause) =>
        isCloudCliCredentialRefreshError(cause)
          ? cause
          : new CloudCliCredentialRefreshError({
              cause,
              ...(HttpClientError.isHttpClientError(cause) &&
              cause.reason._tag === "StatusCodeError"
                ? { status: cause.reason.response.status }
                : {}),
            }),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      Effect.mapError((cause) => new CloudCliCredentialReadError({ cause })),
    ),
  );
  return CloudCliTokenManager.of({ getExisting, hasCredential, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
