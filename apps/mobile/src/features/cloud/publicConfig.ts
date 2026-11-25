import Constants from "expo-constants";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";

export interface CloudPublicConfig {
  readonly relay: {
    readonly url: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  return {
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
    },
  } satisfies CloudPublicConfig;
}
