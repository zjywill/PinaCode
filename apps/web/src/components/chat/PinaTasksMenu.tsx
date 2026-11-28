import { threadKey } from "@t3tools/client-runtime/state/entities";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
  type EnvironmentId,
  reportsTurnsToPina,
  isNamedPinaConversation,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { BotIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import {
  useChildThreadInputs,
  useHiddenThreadKeys,
  useQuietThreadProjection,
  useQuietThreadShells,
  useThreadRelationshipShells,
} from "~/state/entities";
import { useLinkedThreadOpener } from "~/state/linkedThreadView";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface Task {
  ref: ScopedThreadRef;
  title: string;
  needsInput: boolean;
  remote?: OrchestrationV2RemoteTaskChild;
}

function isActiveShell(shell: OrchestrationV2ThreadShell) {
  return (
    Boolean(shell.activityRunStatus) ||
    ["queued", "preparing", "starting", "running", "waiting"].includes(shell.status)
  );
}

function TaskItem({
  task,
  parentRef,
  onOpenThread,
}: {
  task: Task;
  parentRef: ScopedThreadRef;
  onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const gt = useGT();
  const opener = useLinkedThreadOpener(parentRef, task.remote, task.title);
  return (
    <MenuItem
      onClick={() =>
        opener ? opener.open("primary") : onOpenThread(task.ref.threadId, task.ref.environmentId)
      }
    >
      {task.needsInput ? (
        <MessageCircleQuestionMarkIcon aria-label={gt("Needs input")} />
      ) : (
        <BotIcon aria-hidden />
      )}
      <span className="min-w-0 break-words">{task.title}</span>
      {task.remote ? (
        <span className="ms-auto truncate text-xs text-muted-foreground">{task.remote.label}</span>
      ) : null}
    </MenuItem>
  );
}

export function PinaTasksMenu({
  parentRef,
  onOpenThread,
}: {
  parentRef: ScopedThreadRef;
  onOpenThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}) {
  const gt = useGT();
  const projection = useQuietThreadProjection(parentRef)?.projection;
  const shells = useThreadRelationshipShells(parentRef);
  const allShells = useQuietThreadShells();
  const inputs = useChildThreadInputs(parentRef);
  const hidden = useHiddenThreadKeys();
  const tasks = new Map<string, Task>();
  for (const agent of projection?.subagents ?? []) {
    if (!isOrchestrationV2WorkActive(agent.status)) continue;
    const remote = agent.remoteChild;
    const ref =
      remote ??
      (agent.childThreadId && {
        environmentId: parentRef.environmentId,
        threadId: agent.childThreadId,
      });
    if (!ref) continue;
    tasks.set(threadKey(ref), {
      ref,
      title: formatSubagentDisplayTitle(agent.title ?? remote?.title ?? gt("Untitled thread")),
      needsInput: false,
      ...(remote ? { remote } : {}),
    });
  }
  // A child can start a new run after the delegated task that created it finished.
  for (const shell of shells) {
    if (
      shell.lineage.parentThreadId !== parentRef.threadId ||
      shell.lineage.sideChat ||
      (shell.lineage.relationshipToParent !== "subagent" &&
        shell.lineage.relationshipToParent !== "delegation") ||
      !isActiveShell(shell)
    )
      continue;
    const ref = { environmentId: parentRef.environmentId, threadId: shell.id };
    tasks.set(threadKey(ref), {
      ref,
      title: formatSubagentDisplayTitle(shell.title),
      needsInput: false,
    });
  }
  for (const shell of allShells) {
    const ref = { environmentId: shell.environmentId, threadId: shell.id };
    const key = threadKey(ref);
    const existing = tasks.get(key);
    if (
      !existing &&
      (isNamedPinaConversation(parentRef.threadId) ||
        shell.environmentId !== parentRef.environmentId ||
        shell.archivedAt ||
        shell.deletedAt ||
        !reportsTurnsToPina(shell.source) ||
        !isActiveShell(shell.source))
    )
      continue;
    tasks.set(key, {
      ...(existing ?? { ref, title: shell.title }),
      needsInput: shell.hasPendingApprovals || shell.hasPendingUserInput,
    });
  }
  for (const child of inputs) {
    if (child.lineage.sideChat) continue;
    const key = threadKey({ environmentId: child.environmentId, threadId: child.id });
    const task = tasks.get(key);
    tasks.set(key, {
      ...(task ?? {
        ref: { environmentId: child.environmentId, threadId: child.id },
        title: child.title,
      }),
      needsInput: true,
    });
  }
  const visible = [...tasks.entries()].filter(([key]) => !hidden.has(key)).map(([, task]) => task);
  if (visible.length === 0) return null;
  const waiting = visible.filter((task) => task.needsInput);
  const label =
    waiting.length > 0
      ? gt("{count, plural, one {{count} task needs input} other {{count} tasks need input}}", {
          count: waiting.length,
        })
      : gt("{count, plural, one {{count} task in progress} other {{count} tasks in progress}}", {
          count: visible.length,
        });
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant={waiting.length ? "outline" : "ghost-muted"} size="compact" />}
      >
        {waiting.length ? <MessageCircleQuestionMarkIcon aria-hidden /> : <BotIcon aria-hidden />}
        {label}
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-80">
        {[...waiting, ...visible.filter((task) => !task.needsInput)].map((task) => (
          <TaskItem
            key={threadKey(task.ref)}
            task={task}
            parentRef={parentRef}
            onOpenThread={onOpenThread}
          />
        ))}
      </MenuPopup>
    </Menu>
  );
}
