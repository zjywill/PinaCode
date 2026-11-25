import type { EnvironmentId } from "@t3tools/contracts";

export function resolvePinaEnvironment(input: {
  readonly requested: EnvironmentId | null | undefined;
  readonly preferred: EnvironmentId | null | undefined;
  readonly connected: readonly EnvironmentId[];
  readonly permitted: ReadonlySet<EnvironmentId>;
  readonly configs: ReadonlyMap<
    EnvironmentId,
    {
      readonly scratchWorkspaceRoot?: string;
      readonly environment: { readonly capabilities: { readonly pinaAssistant?: boolean } };
    }
  >;
}): EnvironmentId | null {
  const available = (id: EnvironmentId) => {
    const config = input.configs.get(id);
    return (
      input.permitted.has(id) &&
      config?.environment.capabilities.pinaAssistant === true &&
      config.scratchWorkspaceRoot !== undefined
    );
  };
  if (input.requested != null) {
    return input.connected.includes(input.requested) && available(input.requested)
      ? input.requested
      : null;
  }
  if (
    input.preferred != null &&
    input.connected.includes(input.preferred) &&
    available(input.preferred)
  ) {
    return input.preferred;
  }
  return input.connected.find(available) ?? null;
}
