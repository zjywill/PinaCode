import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { APP_ICON_NAMES, type AppIconName } from "@t3tools/contracts";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import Default from "../../../../../assets/pinacode/alternates/preview/DefaultApple.png";
import Gold from "../../../../../assets/pinacode/alternates/preview/Gold.png";
import Amethyst from "../../../../../assets/pinacode/alternates/preview/Amethyst.png";
import Diamond from "../../../../../assets/pinacode/alternates/preview/Diamond.png";
import Pineapple from "../../../../../assets/pinacode/alternates/preview/Pineapple.png";
const previews = { Default, Gold, Amethyst, Diamond, Pineapple };

export function DockIconSetting({
  current,
  select,
}: {
  current: () => Promise<AppIconName>;
  select: (name: AppIconName) => Promise<void>;
}) {
  const gt = useGT();
  const labels = {
    Default: gt("Default"),
    Gold: gt("Gold"),
    Amethyst: gt("Amethyst"),
    Diamond: gt("Diamond"),
    Pineapple: gt("Pineapple crystal"),
  };
  const [icon, setIcon] = useState<AppIconName | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The Electron main process owns the Dock icon preference.
  useEffect(() => {
    let active = true;
    void current()
      .then((name) => {
        if (active) setIcon(name);
      })
      .catch((err) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [current]);
  return (
    <SettingsRow
      {...searchableSetting("dock-icon")}
      title={gt("Dock icon")}
      description={error ?? gt("Choose the icon shown in the Dock while Pina Code is running.")}
      control={
        <Select
          value={icon}
          disabled={busy || !icon}
          onValueChange={async (name: AppIconName | null) => {
            if (!name || name === icon) return;
            setBusy(true);
            setError(null);
            try {
              await select(name);
              setIcon(name);
            } catch (err) {
              setError(String(err));
            }
            setBusy(false);
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Dock icon")}>
            <SelectValue>{icon ? labels[icon] : null}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end">
            {APP_ICON_NAMES.map((name) => (
              <SelectItem key={name} value={name}>
                <img src={previews[name]} width={24} height={24} alt="" />
                {labels[name]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
