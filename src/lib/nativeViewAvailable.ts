import { requireOptionalNativeModule } from "expo-modules-core";

// Detect whether an Expo-module native view is present in the running binary,
// by its backing module Name (expo-blur → "ExpoBlurView",
// expo-linear-gradient → "ExpoLinearGradient").
//
// This uses Expo's own module registry (`requireOptionalNativeModule`), which
// returns null when the module isn't linked and works on BOTH the legacy and
// new (Fabric/bridgeless) architectures. An earlier attempt used
// `UIManager.getViewManagerConfig`, but that reports nothing for Expo/Fabric
// views under the new architecture (which Expo Go SDK 54 runs), so it always
// returned false there and wrongly hid native features that were in fact
// available. `requireOptionalNativeModule` is the reliable signal:
//   - Expo Go / a dev client built WITH the package → module present → true
//   - a stale dev client built BEFORE the package    → null        → false (fallback)
export function nativeViewAvailable(moduleName: string): boolean {
  try {
    return requireOptionalNativeModule(moduleName) != null;
  } catch {
    return false;
  }
}
