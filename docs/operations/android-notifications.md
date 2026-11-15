# Pina Code on Android

Android uses direct environment pairing, including LAN and tailnet addresses. Local notification previews work on the device. Pina Code builds do not require a Firebase project, a Google services file, or a T3 account.

## Build a signed APK locally

From `apps/mobile`, with the workspace dependencies, Android SDK and JDK installed, run:

```sh
export APP_VARIANT=production
export PINACODE_ANDROID_SIGNING_PROPERTIES="$HOME/Git/Vana-Android-keys/keystore.properties"
vp exec expo prebuild --platform android --no-install
(cd android && ./gradlew :app:assembleRelease)
```

The APK is written to `android/app/build/outputs/apk/release/app-release.apk`. Verify its signer with the Android SDK's `apksigner verify --print-certs` before distribution. The properties file and keystore stay in the private signing checkout. Debug builds use the development signing key.
