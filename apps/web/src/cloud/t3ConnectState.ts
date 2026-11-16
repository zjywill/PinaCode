import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import type {
  RelayManagedEndpoint,
  RelayManagedEndpointProviderKind,
} from "@t3tools/contracts/relay";
import { parseUrl } from "@t3tools/shared/url";

// Require managed discovery: stale tunnel config after a publish-only switch causes endpoint_provider_not_managed.
export function isManagedTunnelActive(
  linkState: EnvironmentCloudLinkStateResult,
  relayProviderKind: RelayManagedEndpointProviderKind | undefined,
) {
  const localManagedTunnel = linkState.managedTunnelActive ?? linkState.linked;
  return (
    linkState.linkRevoked !== true &&
    localManagedTunnel &&
    (relayProviderKind === undefined || relayProviderKind === "cloudflare_tunnel")
  );
}

// The URL ends up in commands people paste into a shell, so only plain DNS names pass.
const TUNNEL_HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * An environment's MCP URL on its T3 Connect tunnel, or null. This machine reports its own
 * tunnel hostname; a saved machine's comes from T3 Connect, and only a tunnel counts there,
 * since a publish-only link registers its local address as `manual`.
 */
export function t3ConnectMcpUrl(input: {
  readonly thisMachine: boolean;
  readonly tunnelHostname: string | undefined;
  readonly relayEndpoint: RelayManagedEndpoint | undefined;
}): string | null {
  const url = input.thisMachine
    ? parseUrl(`https://${input.tunnelHostname ?? ""}`)
    : input.relayEndpoint?.providerKind === "cloudflare_tunnel"
      ? parseUrl(input.relayEndpoint.httpBaseUrl)
      : null;
  return url?.protocol === "https:" && TUNNEL_HOSTNAME.test(url.hostname)
    ? `${url.origin}/mcp`
    : null;
}
