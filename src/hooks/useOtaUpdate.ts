import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";
import {
  otaEnabled,
  HARD_BLOCK_ESCAPE_MS,
  FOREGROUND_CHECK_MS,
  type ReloadBlock,
} from "../lib/updates";

/**
 * Fetches OTA updates during a warm session and applies them at a safe moment.
 *
 * The config layer (`fallbackToCacheTimeout: 4000`) only acts at COLD LAUNCH,
 * which is exactly the event that doesn't happen for this app's users: a driver
 * keeps it foregrounded for a whole shift, a passenger leaves it backgrounded for
 * days. So the population that most needs a fix can go days without one.
 *
 * Two rules carry the whole design:
 *
 *  1. Apply only on FOREGROUND RESUME. A reload at that instant is
 *     indistinguishable from a normal cold start. The same reload while someone
 *     is looking at the screen is indistinguishable from a crash — identical
 *     pixels, opposite interpretation.
 *  2. Never apply over a HARD block (active ride, unsaved booking input) — with
 *     one escape: once an update has been waiting longer than
 *     HARD_BLOCK_ESCAPE_MS, the block is not a real ride, it is stuck state (see
 *     the E7 `stuck in_progress` bug). Without the escape, the bug jams the gate
 *     and the fix for it can never land.
 *
 * There is no force/severity channel and that is deliberate: a bundle that
 * crashes at launch cannot run this hook at all, so that case belongs entirely to
 * the native `fallbackToCacheTimeout` path on the relaunch the crash guarantees.
 * Everything reaching this hook is a non-crash regression, where waiting for a
 * safe moment is always the right trade.
 */

/**
 * When this device first saw the CURRENT blocker, persisted so it survives
 * remounts. Keyed by the blocker's id so a new ride starts a fresh clock.
 *
 * Two wrong versions to not drift back into. Timing the *block state* in memory
 * is unreachable: `DriverApp` remounts on sign-out and `activeRide` arrives
 * async, so the first render after any remount reads "none" and resets it — a
 * driver who opens and closes their app would never accumulate the threshold.
 * Timing the *pending update* instead is remount-immune but wrong the other way:
 * an update that had been waiting for hours would reload a ride that started
 * thirty seconds ago, which is precisely the reload this gate exists to prevent.
 */
const BLOCK_SINCE_KEY = "ota.blockSince";

type BlockSince = { id: string; at: number };

async function readBlockSince(id: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(BLOCK_SINCE_KEY);
    const saved: BlockSince | null = raw ? JSON.parse(raw) : null;
    if (saved && saved.id === id) return saved.at;
  } catch {
    // Unreadable storage just means we start the clock now — the escape hatch
    // is a backstop, not something to fail loudly over.
  }
  const at = Date.now();
  try {
    await AsyncStorage.setItem(
      BLOCK_SINCE_KEY,
      JSON.stringify({ id, at } satisfies BlockSince),
    );
  } catch {}
  return at;
}

export function useOtaUpdate(block: ReloadBlock) {
  const { level, id: blockId } = block;
  const { isUpdatePending, isChecking, isDownloading, downloadedUpdate } =
    Updates.useUpdates();

  const levelRef = useRef(level);
  levelRef.current = level;

  const pendingRef = useRef(isUpdatePending);
  pendingRef.current = isUpdatePending;

  // Wall-clock ms since this device first saw the current blocker.
  const blockSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (level !== "hard" || !blockId) {
      blockSinceRef.current = null;
      return;
    }
    let cancelled = false;
    readBlockSince(blockId).then((at) => {
      if (!cancelled) blockSinceRef.current = at;
    });
    return () => {
      cancelled = true;
    };
  }, [level, blockId]);

  // Guard against overlapping checks: `checkForUpdateAsync` while a fetch is
  // already running is wasted radio on a phone already doing GPS + realtime.
  const busyRef = useRef(false);

  /** Returns true if a new bundle finished downloading on this call. */
  const check = async (): Promise<boolean> => {
    if (!otaEnabled() || busyRef.current) return false;
    busyRef.current = true;
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) return false;
      const fetched = await Updates.fetchUpdateAsync();
      return fetched.isNew;
    } catch {
      // Offline, or the server is unreachable. Nothing to do and nothing to say
      // — the next trigger retries. Never surface this: an update the user
      // didn't ask for failing to download is not their problem.
      return false;
    } finally {
      busyRef.current = false;
    }
  };

  const applyIfSafe = (pending = pendingRef.current) => {
    if (!otaEnabled() || !pending) return;
    if (levelRef.current === "hard") {
      const since = blockSinceRef.current;
      const stuck = since !== null && Date.now() - since > HARD_BLOCK_ESCAPE_MS;
      // A block this long isn't a ride — a Valley taxi ride is minutes.
      if (!stuck) return;
    }
    // "soft" falls through with "none": overlay state is recoverable, and this
    // only ever runs on a resume, so the user has already left and come back.
    Updates.reloadAsync().catch(() => {
      // A failed reload leaves the current bundle running, which is safe. The
      // next resume tries again.
    });
  };

  useEffect(() => {
    if (!otaEnabled()) return;

    // Mount: covers a session that has been running long enough to miss the
    // startup check.
    check();

    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      // Something downloaded in a previous session applies immediately.
      applyIfSafe();
      // If THIS resume is what pulled the bundle down, apply on this resume too
      // rather than making the user background and foreground a second time.
      // `isUpdatePending` from useUpdates hasn't necessarily propagated yet, so
      // pass the fetch result directly instead of reading the ref.
      const fetched = await check();
      if (fetched) applyIfSafe(true);
    });

    // For a driver on a 12h shift who never backgrounds the app. Downloads
    // during a long foreground session; the apply still waits for a resume.
    const interval = setInterval(check, FOREGROUND_CHECK_MS);

    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  // An update that finishes downloading while the app is already foregrounded
  // waits for the next resume by design — see rule 1. The exception is an update
  // that has now waited long enough to trip the escape hatch.
  useEffect(() => {
    if (!isUpdatePending || levelRef.current !== "hard") return;
    const since = blockSinceRef.current;
    if (since !== null && Date.now() - since > HARD_BLOCK_ESCAPE_MS) applyIfSafe();
  }, [isUpdatePending, downloadedUpdate?.updateId, blockId]);

  return { isUpdatePending, isBusy: isChecking || isDownloading };
}
