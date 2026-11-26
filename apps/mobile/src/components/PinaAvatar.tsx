import { Image } from "expo-image";

export function PinaAvatar({ size }: { readonly size: number }) {
  return (
    <Image
      source={require("../../../../assets/pinacode/pina-avatar.png")}
      accessible={false}
      accessibilityIgnoresInvertColors
      style={{ width: size, height: size }}
    />
  );
}
