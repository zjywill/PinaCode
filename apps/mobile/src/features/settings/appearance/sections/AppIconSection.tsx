import { useEffect, useState } from "react";
import { useGT } from "../../../../i18n/I18nProvider";
import { Alert, Image, Platform, View } from "react-native";
import { requireOptionalNativeModule } from "expo";
import { APP_ICON_NAMES, type AppIconName } from "@t3tools/contracts";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../../../components/ui/ListRowLayout";
import { Menu } from "../../../../components/ui/Menu";
import { SymbolView } from "../../../../components/ui/AppSymbol";
import { refreshLauncherShortcuts } from "../../../shortcuts/appShortcutsRuntime";
import { SettingsSection } from "../../components/SettingsSection";

const previews = {
  Default:
    Platform.OS === "ios"
      ? require("../../../../../../../assets/pinacode/alternates/preview/DefaultApple.png")
      : require("../../../../../../../assets/pinacode/alternates/preview/Default.png"),
  Gold: require("../../../../../../../assets/pinacode/alternates/preview/Gold.png"),
  Amethyst: require("../../../../../../../assets/pinacode/alternates/preview/Amethyst.png"),
  Diamond: require("../../../../../../../assets/pinacode/alternates/preview/Diamond.png"),
  Pineapple: require("../../../../../../../assets/pinacode/alternates/preview/Pineapple.png"),
};
const native = requireOptionalNativeModule<{
  current(): Promise<AppIconName | null>;
  select(name: AppIconName): Promise<void>;
}>("T3AppIcon");

export function AppIconSection() {
  const gt = useGT();
  const labels = {
    Default: gt("Default"),
    Gold: gt("Gold"),
    Amethyst: gt("Amethyst"),
    Diamond: gt("Diamond"),
    Pineapple: gt("Pineapple crystal"),
  };
  const [current, setCurrent] = useState<AppIconName | null>(null);
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the launcher choice owned by the operating system.
  useEffect(() => {
    let active = true;
    void native
      ?.current()
      .then((name) => {
        if (active) setCurrent(name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!native || !current) return null;
  async function select(name: AppIconName) {
    if (busy || name === current || !native) return;
    setBusy(true);
    try {
      await native.select(name);
      setCurrent(name);
      if (Platform.OS === "android") {
        // Android associates dynamic shortcuts with the enabled launcher activity.
        void refreshLauncherShortcuts().catch((error) =>
          console.warn("[app-shortcuts] could not refresh launcher shortcuts", error),
        );
      }
    } catch (error) {
      Alert.alert(gt("Could not change app icon"), String(error));
    }
    setBusy(false);
  }
  if (Platform.OS === "ios") {
    return (
      <SettingsSection>
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${gt("App icon")}, ${labels[current]}`}
          actions={APP_ICON_NAMES.map((name) => ({
            id: name,
            title: labels[name],
            state: name === current ? "on" : "off",
            attributes: { disabled: busy },
          }))}
          onPressAction={({ nativeEvent }) => {
            const name = APP_ICON_NAMES.find((name) => name === nativeEvent.event);
            if (name) void select(name);
          }}
        >
          <ListRowLayout
            label={gt("App icon")}
            detail={labels[current]}
            leading={<Image source={previews[current]} style={{ width: 32, height: 32 }} />}
            accessory={
              <SymbolView name="chevron.down" size={14} tintColorClassName="accent-icon" />
            }
          />
        </Menu>
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title={gt("App icon")}>
      <View accessibilityRole="radiogroup">
        {APP_ICON_NAMES.map((name, index) => (
          <ListChoiceRow
            key={name}
            label={labels[name]}
            disabled={busy}
            separated={index > 0}
            leading={<Image source={previews[name]} style={{ width: 40, height: 40 }} />}
            selected={current === name}
            onPress={() => void select(name)}
          />
        ))}
      </View>
    </SettingsSection>
  );
}
