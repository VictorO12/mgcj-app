import * as Updates from "expo-updates";
import Constants from "expo-constants";

/**
 * OTA update support. Config lives in `app.config.js`
 * (`updates.url`, `runtimeVersion: { policy: "fingerprint" }`,
 * `fallbackToCacheTimeout: 4000`); the runtime half is `useOtaUpdate`.
 *
 * See `.claude/notes/ota-runtime-design.md` for the reasoning, including why
 * per-publish metadata must never ride in `extra` (it is hashed into the
 * fingerprint, so it would change the runtime version and orphan every
 * installed build).
 */

/**
 * True only where updates can actually run. Expo Go never consumes updates and
 * `__DEV__` builds serve from Metro, so every entry point must no-op when this
 * is false or day-to-day iteration breaks.
 */
export function otaEnabled(): boolean {
  return Updates.isEnabled && !__DEV__;
}

/**
 * How long the SAME hard block must be continuously observed before we stop
 * believing it's a real ride and reload anyway.
 *
 * 2h against a Valley taxi ride measured in minutes; the longest realistic real
 * fare is a Wolfville/Kentville → Halifax airport run at roughly an hour, so
 * there is ~2x margin. The clock is keyed to the blocking ride's id and
 * persisted, so it measures "this device has watched THIS ride block for 2h" —
 * a fresh ride can never inherit an old ride's elapsed time.
 */
export const HARD_BLOCK_ESCAPE_MS = 2 * 60 * 60 * 1000; // 2h

/** Foreground polling interval, for a driver who never backgrounds the app. */
export const FOREGROUND_CHECK_MS = 30 * 60 * 1000; // 30m

/**
 * What the user is in the middle of, from the reload's point of view.
 *
 * This is NOT `interstitialGateOpen`. That predicate answers "is it rude to show
 * a card"; this one answers "is it safe to destroy all in-memory state". A menu
 * being open matters for the first and not the second; an in-flight payment
 * matters for the second and not the first.
 */
export type ReloadBlockLevel =
  /** Nothing in the way — reload freely at the next natural moment. */
  | "none"
  /** Recoverable UI state only (menus, overlays). Defer, but don't defer forever. */
  | "soft"
  /** Active ride or unsaved booking input: losing this costs money or a ride. */
  | "hard";

export type ReloadBlock = {
  level: ReloadBlockLevel;
  /**
   * Identity of the thing doing the blocking — the ride id, or a stable literal
   * for a non-row block like the booking sheet. Required for `level: "hard"`.
   *
   * This is what makes the escape hatch both remount-immune and safe to shorten.
   * Timing the *block state* is unreachable (`DriverApp` remounts on sign-out,
   * and `activeRide` arrives async, so the first render after any remount reads
   * "none" and resets the clock). Timing the *pending update* instead is
   * remount-immune but wrong in the other direction: an update that had been
   * waiting hours would reload a ride that started thirty seconds ago. Keying
   * the clock to the blocker's identity fixes both — the timer starts when this
   * device first sees this specific ride block, and a new ride starts over.
   */
  id?: string | null;
};

export type BuildInfo = {
  /** Store-visible version, e.g. "1.0.0". */
  version: string;
  /** EAS channel the binary was built against ("production"/"preview"/…). */
  channel: string | null;
  /** Short id of the running JS bundle, or null when running embedded code. */
  updateId: string | null;
  /** When the running bundle was published. */
  updatedAt: Date | null;
  /** True when running the JS that shipped inside the binary (no OTA applied). */
  embedded: boolean;
};

export function getBuildInfo(
  currentlyRunning?: Updates.UseUpdatesReturnType["currentlyRunning"],
): BuildInfo {
  const cr = currentlyRunning;
  return {
    version: Constants.expoConfig?.version ?? "—",
    channel: cr?.channel ?? Updates.channel ?? null,
    // `updateId` is undefined on an embedded launch; short-form is enough to
    // identify a bundle and fits on one line of a support screen.
    updateId: cr?.updateId ? cr.updateId.slice(0, 8) : null,
    updatedAt: cr?.createdAt ?? null,
    embedded: cr?.isEmbeddedLaunch ?? true,
  };
}

/**
 * One-line build identity for the Help & Support footer.
 *
 * This exists because OTA breaks the assumption that a store version identifies
 * the code: two drivers on the same store build can now be running different JS.
 * Without this line you cannot tell which bundle a driver reporting a bug is on.
 */
export function formatBuildInfo(info: BuildInfo): string {
  const parts = [`v${info.version}`];
  if (info.embedded || !info.updateId) {
    parts.push("base");
  } else {
    parts.push(info.updateId);
    if (info.updatedAt) {
      parts.push(
        info.updatedAt.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
      );
    }
  }
  // Only worth showing when it isn't the shipping channel.
  if (info.channel && info.channel !== "production") parts.push(info.channel);
  return parts.join(" · ");
}
