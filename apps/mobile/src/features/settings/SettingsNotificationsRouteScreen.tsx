import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsNotificationsRouteScreen() {
  return (
    <SettingsScreen title="Notifications">
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pt-4">
        <Text className="text-base text-foreground-muted">
          Remote notifications are unavailable without T3 Connect.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
