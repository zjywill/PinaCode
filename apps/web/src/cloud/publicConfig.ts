import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export function resolveCloudPublicConfig() {
  return {
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined) ?? "",
    ),
  };
}
