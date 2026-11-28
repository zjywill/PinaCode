import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  isPinaThread,
  type ComposerContextRecord,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  threadContextRecord,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";

export interface PinaSourceThread {
  readonly ref: ScopedThreadRef;
  readonly title: string;
}

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

export function updatePinaComposerDraft<Entry extends ComposerContextRecord>(
  target: ScopedThreadRef,
  source: PinaSourceThread | null,
  draft: { readonly text: string; readonly records: readonly Entry[] },
) {
  const sameEnvironment = source?.ref.environmentId === target.environmentId;
  if (sameEnvironment && source.ref.threadId === target.threadId) return null;

  const automatic = draft.records.filter(
    (record) => record.kind === "thread" && record.contextId.startsWith(PINA_SOURCE_CONTEXT_PREFIX),
  );
  const manual = automatic.length
    ? draft.records.filter((record) => !automatic.includes(record))
    : draft.records;
  const nextSource =
    sameEnvironment &&
    !isPinaThread(source.ref.threadId) &&
    manual.length < COMPOSER_CONTEXT_MAX_RECORDS &&
    !manual.some(
      (record) =>
        record.kind === "thread" &&
        "threadId" in record &&
        record.environmentId === source.ref.environmentId &&
        record.threadId === source.ref.threadId,
    )
      ? {
          ...threadContextRecord(source.ref, source.title),
          contextId: toComposerContextId(PINA_SOURCE_CONTEXT_PREFIX + source.ref.threadId),
        }
      : null;
  if (automatic.length === 0 && nextSource === null) return null;
  const removed = new Set(automatic.map((record) => record.contextId));
  const references = removed.size > 0 ? collectComposerContextReferences(draft.text).reverse() : [];
  if (automatic.length === 1 && automatic[0]?.contextId === nextSource?.contextId) {
    const reference = references.find(
      (entry) => entry.kind === "thread" && removed.has(entry.contextId),
    );
    if (reference) {
      const cursor = reference.end + (draft.text[reference.end] === " " ? 1 : 0);
      return { ...draft, cursor };
    }
  }

  let text = draft.text;
  for (const reference of references) {
    if (reference.kind !== "thread" || !removed.has(reference.contextId)) continue;
    const start = reference.start;
    const end = reference.end;
    const trailingSpace = text[end] === " ";
    text =
      text.slice(0, !trailingSpace && text[start - 1] === " " ? start - 1 : start) +
      text.slice(trailingSpace ? end + 1 : end);
  }
  if (nextSource === null) return { text, records: manual };

  const prefix = `${formatComposerContextReference(nextSource)} `;
  return { text: prefix + text, records: [...manual, nextSource], cursor: prefix.length };
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
