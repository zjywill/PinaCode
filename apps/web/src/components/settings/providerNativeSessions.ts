import type { ServerProvider } from "@t3tools/contracts";

/** Whether the provider can list native sessions, which decides if the settings section renders. */
export function hasNativeSessions(
  provider: ServerProvider | undefined,
): provider is ServerProvider {
  return provider?.driver === "acpRegistry" || provider?.nativeSessions?.canList === true;
}
