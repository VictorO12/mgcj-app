import * as SecureStore from "expo-secure-store";

// SecureStore validates keys against /^[\w.-]+$/ and THROWS on anything else.
// This key started life as an AsyncStorage key ("@driver_device_token") and kept
// its "@" through the move to SecureStore in 318cffd — so from that commit until
// 2026-08-15 every read, write and delete of the driver's device token threw.
// The single-device lock claimed a token in the DB and then failed to store it
// locally, leaving every detector comparing against null and short-circuiting.
// No migration off the old key is needed: nothing was ever successfully written
// under it. Do not reintroduce a prefix character here.
const DEVICE_TOKEN_KEY = "driver_device_token";

// Every helper swallows its error rather than rejecting. These are called from
// realtime callbacks and effects where a floating rejection is invisible — which
// is exactly how the bug above stayed hidden for six weeks.
export async function getDeviceToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(DEVICE_TOKEN_KEY);
  } catch (e) {
    console.error("[Session] could not read device token:", e);
    return null;
  }
}

export async function setDeviceToken(token: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(DEVICE_TOKEN_KEY, token);
    return true;
  } catch (e) {
    console.error("[Session] could not store device token:", e);
    return false;
  }
}

export async function clearDeviceToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY);
  } catch (e) {
    console.error("[Session] could not clear device token:", e);
  }
}
