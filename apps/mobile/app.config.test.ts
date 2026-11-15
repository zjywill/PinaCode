import { afterEach, expect, it, vi } from "vite-plus/test";

import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_ANDROID_GOOGLE_SERVICES_FILE: "/legacy/google-services.json",
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "app.pinacode.client", "pinacode"],
  ["development", "app.pinacode.client.dev", "pinacode-dev"],
  ["preview", "app.pinacode.client.preview", "pinacode-preview"],
  ["production", "app.pinacode.client", "pinacode"],
])(
  "keeps the iOS and Android identifiers for APP_VARIANT=%j",
  async (value, identifier, scheme) => {
    const config = await loadConfig(value);
    expect(config.ios?.bundleIdentifier).toBe(identifier);
    expect(config.android?.package).toBe(identifier);
    expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
    expect(config.scheme).toBe(scheme);
    expect(config.android?.googleServicesFile).toBeUndefined();
  },
);
