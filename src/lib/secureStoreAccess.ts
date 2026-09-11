import * as SecureStore from "expo-secure-store";

// Why every SecureStore write in this app passes through here.
//
// expo-secure-store defaults to WHEN_UNLOCKED (kSecAttrAccessibleWhenUnlocked),
// which makes the keychain item unreadable while the device is locked. That is
// the correct default for a foreground-only app and completely wrong for one
// with a background location task: the task fires, reaches its first
// SecureStore read, and STALLS — not throws, stalls — for as long as the phone
// stays locked.
//
// Measured 2026-09-11 with the task diary: ~60 consecutive invocations over 17
// minutes logged "task entered" and never reached the next line. The control is
// inside the same invocation — the diary itself writes to AsyncStorage, which
// has no keychain protection and worked throughout. Two storage backends,
// microseconds apart, one blocked and one not.
//
// AFTER_FIRST_UNLOCK keeps the item encrypted at rest and unreadable until the
// user has unlocked the device at least once since boot; it only stays readable
// across subsequent locks. This is the standard setting for apps doing
// background work and it is a deliberate choice, not an oversight — do NOT
// "harden" it back to WHEN_UNLOCKED without also moving everything off the
// background path.
export const KEYCHAIN_ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK;

export const secureStoreOptions = { keychainAccessible: KEYCHAIN_ACCESSIBLE };

// Accessibility is a property of the STORED ITEM, fixed when it was written —
// changing the option above does nothing to items already in the keychain. A
// driver who signed in on an older build still has a WHEN_UNLOCKED session and
// would keep stalling. Rewriting on first successful read migrates them without
// a sign-out, needs no list of keys, and no migration flag.
//
// Once per process per key: getItem runs on every getSession, and a keychain
// write on each of those would be its own problem.
const migrated = new Set<string>();

// The DELETE is the load-bearing line, and leaving it out is why the first
// attempt at this silently did nothing (2026-09-11).
//
// expo-secure-store's native setter calls `SecItemAdd`; on an existing key that
// returns errSecDuplicateItem and it falls through to `update()`, whose
// update dictionary is `[kSecValueData: valueData]` — **the value only**
// (`ios/SecureStoreModule.swift:126-137`). `kSecAttrAccessible` is never part
// of an update, so writing over an existing item CANNOT change its
// accessibility. The item keeps whatever it was born with, forever, and no
// amount of ordinary session refreshing heals it. Only delete-then-add reaches
// the `SecItemAdd` path where the attribute is applied.
//
// Accepted risk: delete-then-add is not atomic, so a process kill inside a
// ~10ms window loses the session and signs the driver out. It runs once per key
// per install, only after a successful read (so we are holding the value), and
// the alternative is that background location never works at all.
export async function readAndMigrate(key: string): Promise<string | null> {
  const value = await SecureStore.getItemAsync(key);
  if (value !== null && !migrated.has(key)) {
    migrated.add(key);
    try {
      await SecureStore.deleteItemAsync(key);
      await SecureStore.setItemAsync(key, value, secureStoreOptions);
    } catch {
      // Re-add is the only thing worth retrying: we have just deleted the item,
      // so leaving it absent is strictly worse than leaving it un-migrated.
      try {
        await SecureStore.setItemAsync(key, value, secureStoreOptions);
      } catch {
        console.error("[SecureStore] migration lost key", key);
      }
    }
  }
  return value;
}

/**
 * TEMPORARY probe. `getSession()` does two things that can both hang in a
 * background context — read the keychain, and (inside `_initialize`) make a
 * network call — and from outside they are indistinguishable: the task simply
 * stops. This reads the session key DIRECTLY so the diary can say which.
 *
 * Note the 8s `withTimeout` around the session load did NOT fire on the
 * 2026-09-11 walk. `setTimeout` needs the JS runloop, and between task
 * invocations iOS suspends it — so a timer is not a usable guard here. The
 * probe is, because it either returns or it doesn't before the next entry.
 */
export async function probeAuthKeyRead(supabaseUrl: string): Promise<string> {
  try {
    const ref = new URL(supabaseUrl).hostname.split(".")[0];
    const value = await SecureStore.getItemAsync(`sb-${ref}-auth-token`);
    return value == null ? "miss" : `hit ${value.length}b`;
  } catch (e) {
    return `threw: ${(e as Error).message}`;
  }
}
