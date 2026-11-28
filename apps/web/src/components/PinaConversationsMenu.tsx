import { isPinaThread, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ArchiveIcon, CheckIcon, ChevronDownIcon, MessageCircleIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import {
  refreshArchivedThreadsForEnvironment,
  useArchivedThreadSnapshots,
} from "../lib/archivedThreadsState";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";

export function PinaConversationsMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly conversations: readonly { readonly id: ThreadId; readonly title: string }[];
  readonly selectedId: ThreadId | null;
  readonly onOpen: (id: ThreadId) => void;
  readonly onRestore: (id: ThreadId) => void;
  readonly onCreate: (title: string) => Promise<boolean>;
}) {
  const gt = useGT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiveEnvironment, setArchiveEnvironment] = useState<EnvironmentId | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const { snapshots, isLoading } = useArchivedThreadSnapshots(
    archiveEnvironment === props.environmentId ? [props.environmentId] : [],
  );
  const archived = snapshots.flatMap(({ snapshot }) =>
    snapshot.threads.filter((thread) => isPinaThread(thread.id)),
  );
  const label = gt("Pina conversations");

  return (
    <>
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) {
            setArchiveEnvironment(props.environmentId);
            refreshArchivedThreadsForEnvironment(props.environmentId);
          }
        }}
      >
        <MenuTrigger render={<Button variant="ghost-muted" size="icon-sm" aria-label={label} />}>
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end" className="max-w-72">
          <MenuItem
            onClick={() => {
              setTitle("");
              setCreating(true);
            }}
          >
            <PlusIcon aria-hidden />
            {gt("New Pina conversation")}
          </MenuItem>
          {props.conversations.length > 0 && <MenuSeparator />}
          {props.conversations.map((conversation) => (
            <MenuItem key={conversation.id} onClick={() => props.onOpen(conversation.id)}>
              {conversation.id === props.selectedId ? (
                <CheckIcon aria-hidden />
              ) : (
                <MessageCircleIcon aria-hidden />
              )}
              <span className="min-w-0 truncate">{conversation.title}</span>
            </MenuItem>
          ))}
          {archived.length > 0 && <MenuSeparator />}
          {archived.map((conversation) => (
            <MenuItem
              key={conversation.id}
              onClick={() => props.onRestore(conversation.id)}
              aria-label={gt("Restore and open {title}", { title: conversation.title })}
            >
              <ArchiveIcon aria-hidden />
              <span className="min-w-0 truncate">{conversation.title}</span>
            </MenuItem>
          ))}
          {isLoading && <MenuItem disabled>{gt("Loading archived conversations…")}</MenuItem>}
        </MenuPopup>
      </Menu>
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (saving || !title.trim()) return;
              setSaving(true);
              void props
                .onCreate(title.trim())
                .then((created) => {
                  if (created) setCreating(false);
                })
                .finally(() => setSaving(false));
            }}
          >
            <DialogHeader>
              <DialogTitle>{gt("New Pina conversation")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Input
                aria-label={gt("Conversation name")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                required
              />
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>{gt("Cancel")}</DialogClose>
              <Button type="submit" disabled={saving || !title.trim()}>
                {gt("Create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
