import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  isProviderDriverKind,
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { acpRegistryClient } from "@t3tools/provider-acp-registry/client";
import { makeProviderClientRegistry, type ProviderIcon } from "@t3tools/provider-core/client";
import { modelShortName } from "@t3tools/provider-core/modelShortName";
import { cursorClient } from "@t3tools/provider-cursor/client";
import { fxClient } from "@t3tools/provider-fx/client";
import { grokClient } from "@t3tools/provider-grok/client";
import { kiroClient } from "@t3tools/provider-kiro/client";
import { museClient } from "@t3tools/provider-muse/client";
import { openCodeClient } from "@t3tools/provider-opencode/client";
import { piClient } from "@t3tools/provider-pi/client";

// Dim Web CLI uses this mark in its sidebar and new-session view.
export const dimCodeIcon: ProviderIcon = {
  viewBox: "0 0 45 32",
  fill: { light: "#171717", dark: "#e5e5e5" },
  paths: [
    {
      d: "M30.5753 0.061063C24.084 -0.350713 17.6572 1.3463 12.0353 4.35976C5.50548 7.916 -1.94527 14.9536 0.463184 22.9957C2.3951 28.848 9.11815 30.9755 14.8817 30.9755C17.8697 31.0254 18.1981 26.8827 15.223 26.5021C14.3923 26.4085 13.2267 26.3523 12.4088 26.1839C6.3362 25.1045 3.08415 21.1802 6.96729 15.6524C11.0179 10.1808 18.1273 7.04878 24.889 6.15036C32.3526 5.07724 42.463 8.11566 35.7206 16.6569C34.1557 18.5723 32.1079 20.1944 29.8926 21.5046C29.2487 21.8852 28.4244 21.4422 28.4244 20.7123V16.8378C28.4244 15.2718 27.1171 14.0053 25.5008 14.0053C23.8844 14.0053 22.5771 15.2718 22.5771 16.8378V29.1599C22.5771 30.7259 23.8844 31.9924 25.5008 31.9924C26.8145 31.9924 27.9221 31.1564 28.2892 30.0022C28.4308 29.5654 28.7335 29.1973 29.1714 29.0164C29.6544 28.8168 30.1309 28.6046 30.6075 28.3863C36.5835 25.4976 42.4114 20.9868 44.1502 14.3297C46.1336 5.66371 38.6249 0.52899 30.5753 0.061063Z",
    },
  ],
};

export const dimCodeRegistryIconUrl = officialAcpRegistryIconUrlForAgentId("dimcode");

export function bundledAcpRegistryIcon(iconUrl: string | null | undefined) {
  return iconUrl && iconUrl === dimCodeRegistryIconUrl ? dimCodeIcon : undefined;
}

// OpenRouter's Ink and Cloud glyphs from https://openrouter.ai/brand.
export const openRouterIcon: ProviderIcon = {
  viewBox: "0 0 1024 730",
  fill: { light: "#03080A", dark: "#FCFCFE" },
  paths: [
    {
      d: "M795.893 0C915.776 0 1012.95 97.9963 1012.95 218.88C1012.95 339.764 915.776 437.76 795.893 437.76L1011.2 654.869C1038.55 682.447 1019.18 729.6 980.504 729.6H361.77C161.97 729.6 0 566.273 0 364.8C0 163.327 161.97 0 361.77 0L795.893 0ZM361.77 145.92C241.89 145.92 144.708 243.916 144.708 364.8C144.708 485.684 241.89 583.68 361.77 583.68C481.649 583.68 578.831 485.684 578.831 364.8C578.831 243.916 481.649 145.92 361.77 145.92Z",
    },
  ],
};

export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    modelFamilies: ["GPT-", "GPT "],
    acpRegistryAgentIds: ["codex-acp"],
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    modelFamilies: ["Claude "],
    acpRegistryAgentIds: ["claude-acp"],
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  grokClient,
  fxClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    modelFamilies: ["Gemini "],
    acpRegistryAgentIds: ["antigravity-acp"],
    settingsSchema: AntigravitySettings,
  },
  kiroClient,
  museClient,
  piClient,
  acpRegistryClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}

export function resolveModelShortName(
  model: { readonly name: string; readonly shortName?: string | undefined },
  driverKind: ProviderDriverKind | null | undefined,
): string | undefined {
  if (model.shortName) return model.shortName;
  const families = driverKind ? providerClients.get(driverKind)?.modelFamilies : undefined;
  return modelShortName(model.name, families ?? []);
}
