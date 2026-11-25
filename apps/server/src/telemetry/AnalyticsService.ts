import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
      options?: { readonly anonymous?: boolean },
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;
  }
>()("pinacode/telemetry/AnalyticsService") {}

// Keep the event producers compatible with upstream without creating an identity or a transport.
export const layer = Layer.succeed(AnalyticsService, {
  record: constant(Effect.void),
  flush: Effect.void,
});
