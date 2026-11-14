import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Install the CLI from Pina Code desktop Settings, then run:
      </p>
      <CommandBlock command={command} />
    </div>
  );
}
