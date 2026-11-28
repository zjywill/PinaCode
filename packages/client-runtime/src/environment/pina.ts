import {
  isPinaThread,
  type ComposerContextRecord,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

const PINA_SOURCE_CONTEXT_PREFIX = "pina-source-";

export function activePinaConversations<
  T extends {
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly archivedAt: string | null;
  },
>(threads: readonly T[], environmentId: EnvironmentId | null): readonly T[] {
  return threads.filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.archivedAt === null &&
      isPinaThread(thread.id),
  );
}

export function removeLegacyPinaSourceReferences<Entry extends ComposerContextRecord>(draft: {
  readonly text: string;
  readonly records: readonly Entry[];
}) {
  const automatic = new Set(
    draft.records
      .filter(
        (record) =>
          record.kind === "thread" && record.contextId.startsWith(PINA_SOURCE_CONTEXT_PREFIX),
      )
      .map((record) => record.contextId),
  );
  if (automatic.size === 0) return null;

  let text = draft.text;
  for (const reference of collectComposerContextReferences(draft.text).reverse()) {
    if (reference.kind !== "thread" || !automatic.has(reference.contextId)) continue;
    const start = reference.start;
    const end = reference.end;
    const trailingSpace = text[end] === " ";
    text =
      text.slice(0, !trailingSpace && text[start - 1] === " " ? start - 1 : start) +
      text.slice(trailingSpace ? end + 1 : end);
  }
  return { text, records: draft.records.filter((record) => !automatic.has(record.contextId)) };
}

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
