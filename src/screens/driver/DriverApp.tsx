import React, { useState, useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useDriverLocationBroadcast } from "../../hooks/useDriverLocationBroadcast";
import { useOtaUpdate } from "../../hooks/useOtaUpdate";
import type { ReloadBlock } from "../../lib/updates";
import DriverHomeScreen from "./DriverHomeScreen";
import DriverActiveRideScreen from "./DriverActiveRideScreen";
import DriverSetupScreen from "./DriverSetupScreen";
import AssignedRideScreen from "./AssignedRideScreen";
import AssignedRidesListScreen from "./AssignedRidesListScreen";
import RideRequestSheet from "./RideRequestSheet";
import Constants from "expo-constants";
import { Alert, AppState } from "react-native";
import {
  getDeviceToken,
  setDeviceToken,
  clearDeviceToken,
} from "../../lib/deviceSession";

interface ActiveRide {
  id: string;
  status: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  passenger_name: string | null;
  passenger_avatar_url: string | null;
  payment_method: string | null;
  scheduled_at: string | null;
  leave_by: string | null;
}

interface AssignedRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  scheduled_at: string | null;
  passenger_name: string | null;
  payment_method: string | null;
}

interface PendingRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  fare_estimate: number | null;
  passenger_name: string | null;
  passenger_avatar_url: string | null;
  scheduled_at: string | null;
}

interface DriverRecord {
  vehicle_make: string | null;
  vehicle_model: string | null;
  plate_number: string | null;
}

interface ConfirmedScheduledRide {
  id: string;
  pickup_address: string;
  dropoff_address: string;
  fare_estimate: number | null;
  scheduled_at: string;
  leave_by: string | null;
  passenger_name: string | null;
  /**
   * True for a soft claim (preferred_driver_id = me, driver_id still null) as
   * opposed to a confirmed dispatch assignment. The home-screen card must show
   * the difference: a claim is re-decided at release and can still fall to the
   * pool, and a card that looks assigned when it isn't re-creates the exact
   * failure the soft-claim design exists to prevent.
   */
  claimed: boolean;
}

const ACTIVE_STATUSES = ["assigned", "driver_arriving", "in_progress"];

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function DriverApp() {
  const { profile, signOut } = useAuth();
  useDriverLocationBroadcast(profile?.id, handleHeartbeatRejected);
  const [activeRide, setActiveRide] = useState<ActiveRide | null>(null);
  const [assignedRide, setAssignedRide] = useState<AssignedRide | null>(null);
  const [pendingRide, setPendingRide] = useState<PendingRide | null>(null);
  const [driverRecord, setDriverRecord] = useState<DriverRecord | null>(null);
  const [loadingDriver, setLoadingDriver] = useState(true);
  const [showAssigned, setShowAssigned] = useState(false);
  const [showAssignedList, setShowAssignedList] = useState(false);
  // Which tab AssignedRidesListScreen opens on. Set by whoever opens it — the
  // screen reads this once at mount, and it unmounts on close, so every open
  // gets the tab its trigger intended.
  const [assignedListTab, setAssignedListTab] = useState<"mine" | "open">(
    "mine",
  );
  // Bumped alongside assignedListTab so an ALREADY-OPEN list switches tabs too
  // — setShowAssignedList(true) is a no-op when it's already true, so without
  // this a digest tap on an open list would silently leave them on "mine".
  const [assignedListTabSignal, setAssignedListTabSignal] = useState(0);
  // Unclaimed scheduled rides this driver's company has open. Surfaced on the
  // home screen so the board is discoverable without a push — the digest is a
  // rare nudge by design, so the always-correct signal has to be visible where
  // the driver already is, not buried one screen deep.
  const [openRideCount, setOpenRideCount] = useState(0);
  const openCountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by the notification-tap handler below to tell DriverHomeScreen to
  // pop open the inbox/chat overlay once it's mounted (0 = no pending request).
  const [openInboxSignal, setOpenInboxSignal] = useState(0);
  const [openChatSignal, setOpenChatSignal] = useState(0);
  const [openRideChatSignal, setOpenRideChatSignal] = useState(0);
  const [openRideChatFor, setOpenRideChatFor] = useState<string | null>(null);
  const [confirmedScheduledRides, setConfirmedScheduledRides] = useState<
    ConfirmedScheduledRide[]
  >([]);
  // Ride id the driver has tapped "On My Way" for — moves a scheduled ride
  // from the home-screen countdown card to the active-ride screen without
  // touching `status` (see handleStartRide). Mirrored to `rides.en_route_at`
  // so the passenger app and dispatch dashboard can see the ride is live
  // early, and so it survives an app restart (re-seeded in fetchActiveRide).
  const [startedScheduledRideId, setStartedScheduledRideId] = useState<
    string | null
  >(null);

  // OTA updates are checked/applied here rather than in DriverHomeScreen on
  // purpose: DriverApp is mounted for a driver's entire session, whereas
  // DriverHomeScreen unmounts for the whole active ride. Mounting on the home
  // screen would make "never reload mid-ride" structural, but it would also
  // unmount the escape hatch — so a driver pinned in a stuck `in_progress` ride
  // (the E7 bug) could never receive the fix for it.
  //
  // HARD = a ride the driver is on or being offered: reloading drops nav state,
  // the cash fare entry, or an in-flight capture-payment. Everything else is
  // recoverable, and DriverHomeScreen's own overlay flags aren't visible from
  // here by design — they're SOFT, and we only apply on a foreground resume the
  // driver initiated anyway.
  // `id` keys the escape-hatch clock, so it must identify the specific ride
  // doing the blocking — a fresh ride must never inherit a stuck one's elapsed
  // time. Ride ids are server-side and stable across remounts.
  //
  // A null id means "hard block that never escapes", which is deliberate: the
  // hatch exists for stuck server-side ride state (E7), and the stored clock is
  // never cleared (clearing it would reintroduce the remount bug, since the
  // async activeRide fetch makes the first render after a remount read "none").
  // A constant id would therefore never reset either, so `showAssigned` with no
  // ride would escape on its own two-day-old timestamp.
  const otaBlocker =
    activeRide?.id ?? assignedRide?.id ?? pendingRide?.id ?? null;
  const otaBlock: ReloadBlock =
    otaBlocker || showAssigned
      ? { level: "hard", id: otaBlocker }
      : { level: "none" };
  useOtaUpdate(otaBlock);

  // Ref so handleDeclinePendingRide always reads the latest pendingRide
  // even when called from a stale closure (e.g. timer timeout after 30s)
  const pendingRideRef = useRef<PendingRide | null>(null);
  useEffect(() => {
    pendingRideRef.current = pendingRide;
  }, [pendingRide]);

  // Set when another device claims this account while a ride is in flight.
  // The kick is deferred, never skipped — see performKickOut below.
  const pendingKickRef = useRef(false);
  // Three detectors can fire at once; only the first should sign out.
  const kickingOutRef = useRef(false);

  // Refs so the realtime callback can check "am I free?" without stale closures
  const activeRideRef = useRef<ActiveRide | null>(null);
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);
  const assignedRideRef = useRef<AssignedRide | null>(null);
  useEffect(() => {
    assignedRideRef.current = assignedRide;
  }, [assignedRide]);
  // Same reason: the realtime callback needs to know whether a changed row is
  // one it's currently showing. That's the only way to catch a claim being
  // taken away — scheduled-release CLEARS preferred_driver_id when it hands the
  // ride to the pool, so the incoming row no longer points at this driver.
  const scheduledIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    scheduledIdsRef.current = new Set(confirmedScheduledRides.map((r) => r.id));
  }, [confirmedScheduledRides]);

  // Scheduled offers this driver dismissed — stays open for everyone else
  const dismissedOfferIds = useRef<Set<string>>(new Set());

  // Track rides we're currently processing a decline/timeout for so the
  // realtime callback doesn't re-show the popup while the server is resetting
  const decliningRideIds = useRef<Set<string>>(new Set());

  // Ensures claimDeviceSession runs exactly once per DriverApp mount even if
  // profile object reference changes (onAuthStateChange can fire multiple times).
  const sessionClaimedRef = useRef(false);
  // Resolves once this launch's token is in the DB *and* in SecureStore. Every
  // detector awaits it: on a relaunch SecureStore still holds the previous
  // launch's token, so a check that races the new claim sees a legitimate
  // mismatch and signs the driver out of their own fresh session.
  const claimRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!profile) return;
    fetchDriverRecord();
    fetchActiveRide();
    fetchAssignedRide();
    fetchConfirmedScheduledRides();
    if (!sessionClaimedRef.current) {
      sessionClaimedRef.current = true;
      claimRef.current = claimDeviceSession();
    }
  }, [profile]);

  async function claimDeviceSession() {
    if (!profile) return;
    const token = generateUUID();
    console.log("[Session] claiming device session, token:", token);
    // Write to DB first. When Realtime fires for this update, localToken is
    // still null in SecureStore — the check short-circuits and we don't kick
    // ourselves out. Only AFTER the DB write do we store the token locally,
    // so future Realtime events from another device are correctly caught.
    const { data, error } = await supabase
      .from("drivers")
      .update({ device_token: token })
      .eq("id", profile.id)
      .select("id");
    // On a failed claim, drop any token left over from a previous launch.
    // Leaving it would make every detector compare a token we no longer own
    // against the DB, mismatch, and sign the driver straight back out — a
    // login loop caused by the lock failing, not by a second device.
    if (error) {
      console.error("[Session] failed to write device_token:", error);
      await clearDeviceToken();
      return;
    }
    // An RLS-blocked UPDATE comes back with no error and zero rows. Storing the
    // token locally anyway would leave this device believing it owns a lock the
    // DB never gave it — the whole feature failing without a single log line.
    if ((data?.length ?? 0) === 0) {
      console.error(
        "[Session] device_token write affected 0 rows (RLS?) — lock NOT claimed",
      );
      await clearDeviceToken();
      return;
    }
    console.log("[Session] device_token written to DB");
    const stored = await setDeviceToken(token);
    if (!stored) {
      // We own the lock in the DB but can't remember it, so every detector
      // would compare against null and silently pass. Say so — this is the
      // exact failure mode that hid the invalid-key bug for six weeks.
      console.error(
        "[Session] device token not persisted — displacement detection is DISABLED on this device",
      );
    }
  }

  // Count only — the list screen owns the detail. Mirrors the board's own
  // predicates (unassigned, unclaimed, no dispatch preference, still upcoming)
  // so the number can't disagree with what the Available tab shows.
  // Debounced: the realtime handler below fires on EVERY company ride change,
  // and on a real fleet that's a burst per status transition across every
  // online device. A trailing timer coalesces a burst into one HEAD count —
  // this is a number in a banner, not something that needs to be exact within
  // the same second.
  function scheduleOpenRideCount() {
    if (openCountTimerRef.current) clearTimeout(openCountTimerRef.current);
    openCountTimerRef.current = setTimeout(() => {
      openCountTimerRef.current = null;
      fetchOpenRideCount();
    }, 2000);
  }

  async function fetchOpenRideCount() {
    if (!profile?.company_id) return;
    const { count, error } = await supabase
      .from("rides")
      .select("id", { count: "exact", head: true })
      .eq("company_id", profile.company_id)
      .eq("status", "scheduled")
      .is("driver_id", null)
      .is("preferred_driver_id", null)
      .gte("scheduled_at", new Date().toISOString());
    // Never swallow this. A failed count is indistinguishable from "no open
    // rides" — both render no banner — so without a log a broken query looks
    // exactly like a quiet night.
    if (error) {
      console.warn("[openRideCount] query failed:", error.message);
      return;
    }
    setOpenRideCount(count ?? 0);
  }

  useEffect(() => {
    fetchOpenRideCount();
    return () => {
      if (openCountTimerRef.current) clearTimeout(openCountTimerRef.current);
    };
  }, [profile]);

  // ── Realtime: watch for ride changes on this driver ──────────
  useEffect(() => {
    if (!profile) return;
    const channel = supabase
      .channel("driver-ride-" + profile.id)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "rides",
          filter: "company_id=eq." + profile.company_id,
        },
        async (payload) => {
          if (payload.eventType === "DELETE") {
            const deletedId = (payload.old as any)?.id;
            if (activeRideRef.current?.id === deletedId) setActiveRide(null);
            if (assignedRideRef.current?.id === deletedId)
              setAssignedRide(null);
            setPendingRide((prev) => (prev?.id === deletedId ? null : prev));
            setConfirmedScheduledRides((prev) =>
              prev.filter((r) => r.id !== deletedId),
            );
            return;
          }

          const row = payload.new as any;

          // Any company ride change can open or close a claimable slot, and an
          // open ride has driver_id null — so this has to run before the
          // own-driver filter below, not after it.
          scheduleOpenRideCount();

          // Soft claims, same reasoning as the count above: a claimed ride has
          // driver_id null, so it never survives the own-driver bail below.
          // Both halves are needed — preferred_driver_id catches a claim
          // arriving, the id check catches one going away, since release and
          // scheduled-release's pool handoff both CLEAR preferred_driver_id and
          // the row stops pointing at this driver at all.
          if (
            row.preferred_driver_id === profile.id ||
            scheduledIdsRef.current.has(row.id)
          ) {
            fetchConfirmedScheduledRides();
          }

          if (row.driver_id !== profile.id) return;

          if (row.status === "offered") {
            if (decliningRideIds.current.has(row.id)) return;
            setPendingRide((prev) => {
              if (prev?.id === row.id) return prev;
              showRideRequestPopup(row);
              return prev;
            });
          } else if (
            ACTIVE_STATUSES.includes(row.status) &&
            row.confirmed_by_driver
          ) {
            fetchActiveRide();
            fetchConfirmedScheduledRides();
          } else if (
            ["assigned", "scheduled", "pending"].includes(row.status) &&
            !row.confirmed_by_driver
          ) {
            // Dispatch just (re)assigned this driver directly — show the
            // accept/decline banner + badge immediately instead of waiting
            // for the driver to reopen the app.
            fetchAssignedRide();
          } else if (row.status === "completed" || row.status === "cancelled") {
            setActiveRide(null);
            setAssignedRide(null);
            fetchConfirmedScheduledRides();
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [profile]);

  // ── Single-session enforcement ────────────────────────────────
  // If another device logs in with this driver account, device_token changes.
  // Three independent detectors, because no single one is dependable: the
  // heartbeat compare-and-set (10s, online only), a foreground poll (30s), and
  // Realtime (instant when it works — the drivers table is in the publication,
  // verified 2026-08-15, but it still needs a live socket to reach us).
  // The heartbeat's compare-and-set can come back empty for reasons other than
  // displacement (a stale token read during this launch's claim, or an RLS
  // USING-clause change on `drivers` — both look identical to it), so treat it
  // as a prompt to re-check the authoritative row rather than as a verdict.
  async function handleHeartbeatRejected() {
    if (!profile) return;
    await verifyDeviceToken(profile.id);
  }

  async function handleKickedOut() {
    // Mid-ride, the sign-out is deferred rather than skipped. Skipping it
    // used to leave the driver in a half-dead session: this device's
    // auth.sessions row was already gone (the other device's sign-in saw to
    // that), so the UI and the heartbeat kept working on an orphaned JWT
    // while capture-payment 401'd — the driver could drive the trip but
    // never end it, stranding the passenger's hold until a sweep cancelled
    // it hours later. Warn now, eject when the ride is actually over.
    if (activeRideRef.current) {
      if (pendingKickRef.current) return;
      pendingKickRef.current = true;
      Alert.alert(
        "Signed in on another device",
        "You'll be signed out here once you finish this ride.",
        [{ text: "OK" }],
      );
      return;
    }
    await performKickOut();
  }

  // Poll the authoritative token. Realtime is the fast path but it is not a
  // guarantee — a backgrounded socket, Expo Go on Android, or a device that
  // was simply offline when the other login happened all miss the event.
  async function verifyDeviceToken(driverId: string) {
    await claimRef.current;
    const localToken = await getDeviceToken();
    // A missing local token means this device never claimed the account, so
    // there is nothing to be kicked out of — no sign-in race to guard.
    if (!localToken) return;
    const { data, error } = await supabase
      .from("drivers")
      .select("device_token")
      .eq("id", driverId)
      .maybeSingle();
    if (error || !data) {
      // Can't read our own row (RLS or network) — say so rather than silently
      // reading this as "not displaced", which is how a broken policy would
      // disable the whole check invisibly.
      console.warn(
        "[Session] device_token check could not read the row:",
        error?.message,
      );
      return;
    }
    if (data.device_token && data.device_token !== localToken) {
      handleKickedOut();
    }
  }

  useEffect(() => {
    if (!profile) return;
    const driverId = profile.id;

    // Realtime: watch own drivers row for device_token changes
    const channel = supabase
      .channel("driver-session-" + driverId)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "drivers",
          filter: "id=eq." + driverId,
        },
        async (payload) => {
          await claimRef.current;
          const newToken = (payload.new as any)?.device_token;
          const localToken = await getDeviceToken();
          // Only kick out if a real (non-null) new token doesn't match ours
          if (localToken && newToken && newToken !== localToken) {
            handleKickedOut();
          }
        },
      )
      .subscribe();

    // Cold start: AppState is already "active" when the app mounts, so the
    // listener below never fires for a launch. Without this, a device that was
    // displaced while closed comes back up believing it still holds the lock.
    verifyDeviceToken(driverId);

    // While foregrounded, nothing else was checking: a device left open just
    // kept working after being displaced (observed 2026-08-15). The heartbeat
    // covers the online case; this covers a driver sitting offline in the app.
    const poll = setInterval(() => verifyDeviceToken(driverId), 30000);

    // AppState: verify token on foreground resume (catches offline case)
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      verifyDeviceToken(driverId);
    });

    return () => {
      supabase.removeChannel(channel);
      clearInterval(poll);
      appStateSub.remove();
    };
  }, [profile]);

  // ── Handle notification tap ───────────────────────────────────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const action = response.actionIdentifier;
        const data = response.notification.request.content.data ?? {};

        if (data.type === "dispatch_message") {
          setOpenInboxSignal((s) => s + 1);
          return;
        }
        if (data.type === "driver_chat") {
          setOpenChatSignal((s) => s + 1);
          return;
        }

        // A message from the passenger on the ride the driver is currently on.
        // Distinct from driver_chat, which is dispatch — different thread,
        // different screen, and conflating them would open the wrong one.
        // Deliberately does NOT fall through to the rideId guard below: the
        // thread lives inside DriverActiveRideScreen, which is already the
        // mounted screen for this ride, so this only has to raise it.
        if (data.type === "ride_chat") {
          // Carry the ride the push was about. A driver can be on ride Y while
          // a passenger from just-completed ride X messages them inside the 2h
          // window, and opening Y's thread for X's message shows the wrong
          // conversation to the wrong person.
          setOpenRideChatFor(typeof data.rideId === "string" ? data.rideId : null);
          setOpenRideChatSignal((n) => n + 1);
          return;
        }

        // Daily "tomorrow's open rides" digest. Company-wide, so it carries no
        // rideId and must be handled above the guard below.
        if (data.type === "available_rides_digest") {
          setAssignedListTab("open");
          setAssignedListTabSignal((n) => n + 1);
          setShowAssignedList(true);
          return;
        }

        const rideId = data.rideId;
        if (!rideId || !profile) return;

        // "Still good for your planned ride?" — asymmetric by design: there is
        // nothing to accept here, so any tap just opens the list, where the
        // Release button lives. Ignoring it costs the driver nothing.
        if (data.type === "claim_checkin") {
          setAssignedListTab("mine");
          setShowAssignedList(true);
          return;
        }

        // The claim didn't convert at release and the ride went to the pool.
        if (data.type === "claim_released") {
          await fetchConfirmedScheduledRides();
          setAssignedListTab("mine");
          setShowAssignedList(true);
          return;
        }

        if (data.type === "departure_reminder") {
          // leave_by has arrived — refresh so countdown screen shows Start button
          await fetchActiveRide();
          return;
        }

        if (action === Notifications.DEFAULT_ACTION_IDENTIFIER) {
          await fetchAssignedRide();
          setShowAssigned(true);
        } else if (action === "ACCEPT") {
          const { error } = await supabase
            .from("rides")
            .update({
              driver_id: profile.id,
              status: "assigned",
              confirmed_by_driver: true,
            })
            .eq("id", rideId)
            .eq("status", "offered");
          // fetchActiveRide routes to countdown (scheduled) or active (immediate)
          if (!error) fetchActiveRide();
        } else if (action === "DECLINE") {
          console.log("Driver declined ride from notification:", rideId);
        }
      },
    );
    return () => sub.remove();
  }, [profile]);

  // ── Fetch a ride row and show the RideRequestSheet popup ─────
  async function showRideRequestPopup(rideRow: any) {
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, avatar_url")
      .eq("id", rideRow.passenger_id)
      .maybeSingle();

    setPendingRide({
      id: rideRow.id,
      pickup_address: rideRow.pickup_address,
      dropoff_address: rideRow.dropoff_address,
      pickup_lat: rideRow.pickup_lat,
      pickup_lng: rideRow.pickup_lng,
      dropoff_lat: rideRow.dropoff_lat,
      dropoff_lng: rideRow.dropoff_lng,
      fare_estimate: rideRow.fare_estimate,
      passenger_name: passenger?.name ?? null,
      passenger_avatar_url: passenger?.avatar_url ?? null,
      scheduled_at: rideRow.scheduled_at ?? null,
    });
  }

  // ── Confirm ride (accept from popup or notification) ─────────
  async function confirmRide(rideId: string) {
    if (!profile) return;
    const { error } = await supabase
      .from("rides")
      .update({ confirmed_by_driver: true, status: "assigned" })
      .eq("id", rideId)
      .eq("driver_id", profile.id)
      .eq("status", "offered");

    if (!error) {
      setPendingRide(null);
      fetchActiveRide();
      fetchConfirmedScheduledRides();
    }
  }

  // ── Decline and immediately trigger reassignment server-side ──
  async function declineAndReassign(rideId: string, timedOut: boolean = false) {
    if (!profile) return;
    const supabaseUrl = Constants.expoConfig?.extra?.supabaseUrl;

    decliningRideIds.current.add(rideId);
    setPendingRide(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) return;

      await fetch(`${supabaseUrl}/functions/v1/assign-ride`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          ride_id: rideId,
          // Hard decline → declined_by_driver_id (excluded permanently)
          // Timeout → timed_out_driver_id (eligible again on second pass)
          ...(timedOut
            ? { timed_out_driver_id: profile.id }
            : { declined_by_driver_id: profile.id }),
        }),
      });
    } catch (e) {
      console.error("[declineAndReassign] fetch error:", e);
    } finally {
      setTimeout(() => {
        decliningRideIds.current.delete(rideId);
      }, 3000);
    }
  }

  // ── Accept from popup sheet ───────────────────────────────────
  async function handleAcceptPendingRide() {
    const ride = pendingRideRef.current;
    if (!ride) return;
    await confirmRide(ride.id);
  }

  // ── Decline from popup sheet (manual or timeout) ─────────────
  // Uses pendingRideRef so the timer callback (fired 30s after mount)
  // always reads the current ride, not a stale closure value
  async function handleDeclinePendingRide(timedOut: boolean) {
    const ride = pendingRideRef.current;
    if (!ride) return;
    await declineAndReassign(ride.id, timedOut);
  }

  async function fetchDriverRecord() {
    if (!profile) return;
    const { data } = await supabase
      .from("drivers")
      .select("vehicle_make, vehicle_model, plate_number")
      .eq("id", profile.id)
      .single();
    setDriverRecord(data);
    setLoadingDriver(false);
  }

  async function fetchActiveRide() {
    if (!profile) return;
    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ACTIVE_STATUSES)
      .eq("confirmed_by_driver", true)
      .order("created_at", { ascending: false })
      .limit(1);

    if (!rides || rides.length === 0) {
      setActiveRide(null);
      return;
    }
    const ride = rides[0];
    // Re-seed the "On My Way" state after an app restart so the driver lands
    // back on the active-ride screen rather than the countdown card.
    if (ride.en_route_at) setStartedScheduledRideId(ride.id);
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name, avatar_url")
      .eq("id", ride.passenger_id)
      .single();
    setActiveRide({
      id: ride.id,
      status: ride.status,
      pickup_address: ride.pickup_address,
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      dropoff_address: ride.dropoff_address,
      dropoff_lat: ride.dropoff_lat,
      dropoff_lng: ride.dropoff_lng,
      fare_estimate: ride.fare_estimate,
      passenger_name: passenger?.name ?? null,
      passenger_avatar_url: passenger?.avatar_url ?? null,
      payment_method: ride.payment_method ?? null,
      scheduled_at: ride.scheduled_at ?? null,
      leave_by: ride.leave_by ?? null,
    });
  }

  // Everything on this driver's calendar: rides dispatch assigned and they
  // confirmed, PLUS rides they soft-claimed off the Available board. Two
  // queries because a claim leaves driver_id null by design — that's the whole
  // point of it being non-binding — so no single filter reaches both.
  async function fetchConfirmedScheduledRides() {
    if (!profile) return;
    const now = new Date().toISOString();

    const [assignedRes, claimedRes] = await Promise.all([
      supabase
        .from("rides")
        .select("*")
        .eq("driver_id", profile.id)
        .eq("confirmed_by_driver", true)
        .in("status", ["assigned", "scheduled", "pending"])
        .not("scheduled_at", "is", null)
        .gt("scheduled_at", now),
      // Predicates mirror fetchPlannedRides in AssignedRidesListScreen exactly,
      // so the home panel and the board can never disagree about what counts as
      // planned.
      supabase
        .from("rides")
        .select("*")
        .eq("preferred_driver_id", profile.id)
        .not("claimed_at", "is", null)
        .eq("status", "scheduled")
        .is("driver_id", null)
        .gt("scheduled_at", now),
    ]);

    const rows = [
      ...(assignedRes.data ?? []).map((r) => ({ ride: r, claimed: false })),
      ...(claimedRes.data ?? []).map((r) => ({ ride: r, claimed: true })),
    ];
    if (!assignedRes.data && !claimedRes.data) return;

    const enriched = await Promise.all(
      rows.map(async ({ ride, claimed }) => {
        const { data: p } = await supabase
          .from("profiles")
          .select("name")
          .eq("id", ride.passenger_id)
          .maybeSingle();
        return {
          id: ride.id,
          pickup_address: ride.pickup_address,
          dropoff_address: ride.dropoff_address,
          fare_estimate: ride.fare_estimate,
          scheduled_at: ride.scheduled_at,
          leave_by: ride.leave_by ?? null,
          passenger_name: p?.name ?? null,
          claimed,
        };
      }),
    );
    enriched.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    setConfirmedScheduledRides(enriched);
  }

  async function fetchAssignedRide() {
    if (!profile) return;
    const { data: rides } = await supabase
      .from("rides")
      .select("*")
      .eq("driver_id", profile.id)
      .in("status", ["offered", "assigned", "scheduled", "pending"])
      .eq("confirmed_by_driver", false)
      .order("scheduled_at", { ascending: true, nullsFirst: false })
      .limit(1);
    if (!rides || rides.length === 0) {
      setAssignedRide(null);
      return;
    }
    const ride = rides[0];
    const { data: passenger } = await supabase
      .from("profiles")
      .select("name")
      .eq("id", ride.passenger_id)
      .single();
    setAssignedRide({
      id: ride.id,
      pickup_address: ride.pickup_address,
      dropoff_address: ride.dropoff_address,
      pickup_lat: ride.pickup_lat,
      pickup_lng: ride.pickup_lng,
      dropoff_lat: ride.dropoff_lat,
      dropoff_lng: ride.dropoff_lng,
      fare_estimate: ride.fare_estimate,
      scheduled_at: ride.scheduled_at,
      passenger_name: passenger?.name ?? null,
      payment_method: ride.payment_method ?? null,
    });
  }

  function handleRideStatusChange(newStatus: string) {
    if (!activeRide) return;
    setActiveRide({ ...activeRide, status: newStatus });
  }

  async function performKickOut() {
    // Three detectors can race here (heartbeat, poll, Realtime) — and the
    // deferred-kick drain is a fourth caller. Only the first should sign out,
    // or the driver gets a stack of identical alerts.
    if (kickingOutRef.current) return;
    kickingOutRef.current = true;
    pendingKickRef.current = false;
    Alert.alert("Signed out", "Your account was signed in on another device.", [
      { text: "OK" },
    ]);
    await clearDeviceToken();
    await signOut();
  }

  // Drain the deferred kick wherever the ride ends. There are several places
  // activeRide gets cleared (completion, the realtime completed/cancelled
  // branch, a row delete, a refetch finding nothing), so watch the state
  // rather than trying to remember them all.
  useEffect(() => {
    if (!activeRide && pendingKickRef.current) {
      performKickOut();
    }
  }, [activeRide]);

  function handleRideComplete() {
    setActiveRide(null);
    fetchConfirmedScheduledRides();
  }

  function handleSetupComplete() {
    fetchDriverRecord();
  }

  async function handleAcceptRide() {
    setAssignedRide(null);
    setShowAssigned(false);
    // Always fetch active ride — scheduled rides land on countdown screen,
    // immediate rides land on active screen. Both paths route the same way.
    await fetchActiveRide();
    fetchConfirmedScheduledRides();
  }

  function handleDeclineRide() {
    setAssignedRide(null);
    setShowAssigned(false);
  }

  // ── Driver taps "On My Way" on the countdown card ────────────
  // This is just the departure go-ack that switches from the home-screen
  // countdown card to the turn-by-turn active-ride screen — it must NOT
  // flip status to driver_arriving, since that status means "arrived at
  // pickup" everywhere else (passenger push copy, driver's own button
  // label) and would falsely tell the passenger the driver is already
  // there while also skipping the driver's real "I've arrived" step and
  // its turn-by-turn nav to the pickup.
  async function handleStartRide() {
    if (!activeRide) return;
    setStartedScheduledRideId(activeRide.id);
    // Publish the departure so the passenger's tracking sheet opens and the
    // ride moves from Scheduled to Active on the dashboard. Timestamp only —
    // `status` is untouched, so notify-passenger (which fires on a status
    // change or confirm) stays quiet and no premature "driver has arrived"
    // push goes out. Best-effort: local state already switched the screen, so
    // a failed write must not block the driver from driving.
    const rideId = activeRide.id;
    const { data, error } = await supabase
      .from("rides")
      .update({ en_route_at: new Date().toISOString() })
      .eq("id", rideId)
      .eq("driver_id", profile?.id ?? "")
      .is("en_route_at", null)
      // .select() so we can tell a no-op apart from a success: a write filtered
      // out by RLS comes back with zero rows and error === null, so checking
      // `error` alone would miss the most likely failure.
      .select("id");
    if (error) {
      console.error("[handleStartRide] en_route_at write failed:", error);
    } else if (!data || data.length === 0) {
      // Either already stamped (driver re-tapped, or resumed after a restart)
      // or the row was filtered out. Harmless in the first case; log so the
      // second isn't invisible.
      console.log("[handleStartRide] en_route_at not written for", rideId);
    }
  }

  if (loadingDriver) return null;

  if (!driverRecord?.vehicle_make || !driverRecord?.plate_number) {
    return <DriverSetupScreen onComplete={handleSetupComplete} />;
  }

  if (showAssigned && assignedRide) {
    return (
      <AssignedRideScreen
        ride={assignedRide}
        onAccept={handleAcceptRide}
        onDecline={handleDeclineRide}
        onClose={() => setShowAssigned(false)}
      />
    );
  }

  if (
    activeRide &&
    (!(activeRide.scheduled_at && activeRide.status === "assigned") ||
      startedScheduledRideId === activeRide.id)
  ) {
    return (
      <DriverActiveRideScreen
        key={activeRide.id}
        ride={activeRide}
        onRideComplete={handleRideComplete}
        onStatusChange={handleRideStatusChange}
        kickPendingRef={pendingKickRef}
        openChatSignal={openRideChatSignal}
        openChatRideId={openRideChatFor}
      />
    );
  }

  if (showAssignedList) {
    return (
      <AssignedRidesListScreen
        initialTab={assignedListTab}
        openTabSignal={assignedListTabSignal}
        onClose={() => setShowAssignedList(false)}
        hasActiveRide={!!activeRide}
        onAccepted={() => {
          setShowAssignedList(false);
          fetchActiveRide();
          fetchConfirmedScheduledRides();
        }}
        onReleased={() => {
          // Stay on the list — the driver may be triaging several rides — but
          // re-read active state so the released ride stops being `activeRide`.
          setStartedScheduledRideId(null);
          fetchActiveRide();
          fetchConfirmedScheduledRides();
        }}
      />
    );
  }

  return (
    <>
      <DriverHomeScreen
        assignedRide={assignedRide}
        onOpenAssigned={() => {
          setAssignedListTab("mine");
          setAssignedListTabSignal((n) => n + 1);
          setShowAssignedList(true);
        }}
        openRideCount={openRideCount}
        onOpenAvailable={() => {
          setAssignedListTab("open");
          setAssignedListTabSignal((n) => n + 1);
          setShowAssignedList(true);
        }}
        confirmedScheduledRides={confirmedScheduledRides}
        onOpenPlanned={() => {
          setAssignedListTab("mine");
          setAssignedListTabSignal((n) => n + 1);
          setShowAssignedList(true);
        }}
        onRideAccepted={fetchActiveRide}
        openInboxSignal={openInboxSignal}
        openChatSignal={openChatSignal}
        activeScheduledRide={
          activeRide?.scheduled_at && activeRide.status === "assigned"
            ? activeRide
            : null
        }
        onStartRide={handleStartRide}
      />
      {pendingRide && (
        <RideRequestSheet
          ride={pendingRide}
          onAccept={handleAcceptPendingRide}
          onDecline={handleDeclinePendingRide}
        />
      )}
    </>
  );
}
