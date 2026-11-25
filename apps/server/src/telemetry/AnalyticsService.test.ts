import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("completes product events and shutdown without sending a request", () => {
  const send = vi.fn<typeof fetch>();
  return Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("server.boot.heartbeat", { projectCount: 1 });
    yield* analytics.flush;
  }).pipe(
    Effect.provide(AnalyticsService.layer),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, send),
    Effect.tap(() => Effect.sync(() => expect(send).not.toHaveBeenCalled())),
  );
});
