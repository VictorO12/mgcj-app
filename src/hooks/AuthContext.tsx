import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
} from "react";
import { supabase } from "../lib/supabase";
import type { Profile } from "../types";
import type { Session } from "@supabase/supabase-js";
import { getDeviceToken, clearDeviceToken } from "../lib/deviceSession";
import * as Updates from "expo-updates";

interface AuthContextType {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /**
   * True when the loading gate has been up long enough that something is
   * wrong rather than slow. Exists so the launch spinner can never again be a
   * dead end: the app renders a visible "retry" state instead of a spinner
   * with no exit. See the watchdog below.
   */
  stalled: boolean;
  /**
   * The launch is blocked on a request that failed for lack of connectivity,
   * rather than on anything the app can finish by waiting. Distinct from
   * `stalled`, which means "slow for an unknown reason" — the two want
   * different words on screen and different recovery.
   */
  offline: boolean;
  retryInit: () => void;
  /** Manual "try again"; the same thing the auto-retry does on its own. */
  retryConnection: () => void;
  signOut: () => Promise<void>;
  refetch: () => Promise<void>;
  // Driver registration uses these to prevent the home screen from flashing
  // while the invite code is being validated after OTP verification.
  holdLoading: () => void;
  releaseLoading: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

/**
 * Every column of `profiles`, enumerated rather than starred.
 *
 * A star select asks Postgres to expand it to every column and requires SELECT
 * on all of them — so once `phone` is revoked (see
 * `.claude/notes/g3-phone-column-revoke-plan.md`) a star does not silently omit
 * the column, it fails the whole query with `permission denied for column
 * phone`. This is the auth path: that is not a degraded profile screen, it is
 * nobody being able to log into the app.
 *
 * This list is deliberately IDENTICAL to what the star returns today. The
 * revoke has not happened yet and this change is a behavioural no-op on
 * purpose, so it can ship and be confirmed on real devices by itself. The five
 * columns marked below leave this list in the same commit that reroutes their
 * readers through the definer RPC; removing one before then just blanks a
 * field.
 *
 * PostgREST defaults to the star when `.select()` is called with no argument,
 * so a future bare call reintroduces the hazard. Use this constant.
 */
const PROFILE_COLUMNS =
  // phone, email, student_email, stripe_customer_id and guest_phone are
  // deliberately ABSENT: 20260765 withholds them from the client roles, so
  // naming one here fails the whole query with `permission denied for column
  // <x>` — on the auth path, which is nobody logging in. They come from
  // my_private_profile() instead, merged in below.
  //
  // Kept on ONE literal line: supabase-js infers the row type from the literal
  // type of this string, and any concatenation or .join() widens it to `string`,
  // which degrades every field to GenericStringError.
  "id, name, role, company_id, avatar_url, created_at, is_active, deactivation_pending, deleted_at, notification_prefs, push_token, is_guest, student_verified, student_institution_id, student_verified_at";

/**
 * Is this failure "there is no network" rather than "the server said no"?
 *
 * Deliberately message-based rather than using a connectivity library:
 * @react-native-community/netinfo and expo-network are both NATIVE modules, and
 * neither is installed. Adding one changes the fingerprint, which orphans every
 * installed build from OTA until a new binary ships — a heavy price for a
 * string on a spinner. What we actually need to know is not "does the device
 * have an interface up" but "did this request fail because it could not leave
 * the phone", and the thrown error already answers that.
 *
 * React Native's fetch throws `TypeError: Network request failed` with no
 * connectivity. The abort from timeoutFetch counts too: a request that never
 * answered inside the ceiling is, from the user's point of view, the same
 * condition and the same fix.
 */
function isNetworkError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  const msg = String(e?.message ?? err ?? "").toLowerCase();
  return (
    e?.name === "AbortError" ||
    msg.includes("network request failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("aborted")
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [stalled, setStalled] = useState(false);
  const [offline, setOffline] = useState(false);
  const [initAttempt, setInitAttempt] = useState(0);
  const sessionRef = useRef<Session | null>(null);
  const fetchingForRef = useRef<string | null>(null);
  // Mirrors `profile` for the finally-block check below, which runs inside an
  // async closure and would otherwise read a stale captured value.
  const profileRef = useRef<Profile | null>(null);
  const loadingHeldRef = useRef(false);

  /**
   * Last-resort net under the launch gate.
   *
   * `timeoutFetch` (see src/lib/timeoutFetch.ts) fixes the known cause — a
   * stalled /auth/v1/token refresh that leaves auth-js's `initializePromise`
   * unsettled, hanging `getSession()` and the INITIAL_SESSION emit at once —
   * so this should essentially never fire. It is here because the class of bug
   * is "an await that never settles", and the two rounds of fixes before this
   * one both failed by assuming a specific await was the only one. A ceiling
   * on the gate itself is the only thing that holds no matter which await it
   * is: SecureStore, the profile query, or something not yet written.
   *
   * It deliberately does NOT force `loading` false. Dropping a signed-in
   * driver mid-shift onto the Welcome screen is worse than the spinner — they
   * would try to re-auth and hit OTP for a session they already have. It
   * surfaces a retry affordance instead and leaves the decision to the user.
   *
   * Above the 20s fetch ceiling on purpose, so a request that is merely slow
   * resolves normally rather than racing this.
   */
  useEffect(() => {
    if (!loading) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), 30000);
    return () => clearTimeout(timer);
  }, [loading, initAttempt]);

  /**
   * Retry has to RELOAD, not just re-run — verified against auth-js 2.109.0.
   *
   * `initialize()` memoizes: `if (this.initializePromise) return await
   * this.initializePromise`, and that field is assigned exactly once and never
   * reset to null anywhere in the library. So if the hang is INSIDE
   * `_initialize` (a wedged SecureStore read, or a refresh fetch that outlives
   * even the 20s ceiling), calling `getSession()` again just awaits the same
   * unsettled promise and nothing happens. Only a fresh JS context clears it —
   * which is exactly why force-quitting is the workaround that has been
   * working all along, and why a plain re-run would have shipped a Retry
   * button that does nothing for the one case it exists to cover.
   *
   * The in-place re-run is kept as the fallback: it is the correct fix for a
   * hang AFTER init (the profile query, where `initializePromise` has already
   * resolved), and it is what runs if `reloadAsync` is unavailable — it throws
   * in Expo Go and in dev where there is no updates-enabled build.
   */
  function retryInit() {
    Updates.reloadAsync().catch((err) => {
      console.warn("[Auth] reload unavailable, re-running init:", err);
      fetchingForRef.current = null;
      setStalled(false);
      setLoading(true);
      setInitAttempt((n) => n + 1);
    });
  }

  /**
   * Re-attempt whatever the launch is blocked on. Safe to call repeatedly.
   *
   * Deliberately NOT a reload: unlike the init deadlock (which needed a fresh JS
   * context because `initializePromise` is memoised and never reset), a failed
   * network read leaves init RESOLVED. Calling `getSession()` again genuinely
   * re-runs the read, so recovery costs nothing and destroys no state.
   */
  function retryConnection() {
    supabase.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        if (session) {
          setOffline(false);
          setStalled(false);
          setSession(session);
          sessionRef.current = session;
          if (fetchingForRef.current !== session.user.id) {
            fetchingForRef.current = session.user.id;
            fetchProfile(session.user.id);
          }
        } else if (!error) {
          // Genuinely signed out — stop calling this offline.
          setOffline(false);
          setLoading(false);
        }
      })
      .catch((err) => console.warn("[Auth] retry failed:", err));
  }

  /**
   * Auto-recovery. The user asked not to have to press anything, and this is
   * the case where that is actually achievable: nothing is wedged, the phone
   * simply has no signal yet, so re-asking on a timer will start working the
   * moment it does.
   *
   * 4s is a compromise, not a measurement. Note one wrinkle: auth-js caches a
   * failed refresh for REFRESH_FAILURE_COOLDOWN_MS (60s) keyed by refresh
   * token, so if the block is a failed REFRESH some of these ticks are answered
   * from that cache rather than the network, and recovery can lag the network
   * coming back by up to a minute. When the block is the profile query — the
   * common case, and the one seen in airplane mode — there is no cache and
   * recovery is immediate.
   */
  useEffect(() => {
    // `loading` is in the condition as a backstop: retrying is only ever useful
    // while the gate is up, so even if some future path leaves `offline` set
    // after launch, the timer cannot outlive the screen it exists for.
    if (!offline || !loading) return;
    const id = setInterval(retryConnection, 4000);
    return () => clearInterval(id);
  }, [offline, loading]);

  useEffect(() => {
    // The .catch is load-bearing, not defensive dressing: getSession() awaits
    // the client's initialize(), which reads SecureStore and can fire a token
    // refresh over the network. An unhandled rejection there left `loading`
    // true with nothing scheduled to ever set it false — the same forever
    // spinner as the fetchProfile latch below, one call earlier. Treat a
    // failure to READ the session as no session: the Welcome screen is a
    // recoverable state, a spinner is not.
    supabase.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        setSession(session);
        sessionRef.current = session;
        // Same claim check as the subscriber below — whichever path gets here
        // first owns the fetch. Without this the two race and both run.
        if (session) {
          setOffline(false);
          if (fetchingForRef.current !== session.user.id) {
            fetchingForRef.current = session.user.id;
            fetchProfile(session.user.id);
          }
        } else if (error) {
          // A null session WITH an error is a failed read, not a sign-out.
          // `__loadSession` returns `{ session: null, error }` when a refresh
          // fails and the access token has already expired — which is exactly
          // what an offline launch looks like after the app has sat overnight.
          //
          // The session is still on disk: `_callRefreshToken` only calls
          // `_removeSession()` when the error is NOT retryable, and a network
          // failure is retryable. So dropping to Welcome here would be a lie —
          // and a costly one, because re-login needs an SMS OTP, i.e. the
          // network the user does not have. Hold, say why, and retry.
          console.warn("[Auth] session read failed:", error.message);
          setOffline(true);
        } else {
          // Genuinely signed out: no session, no error.
          setLoading(false);
        }
      })
      .catch((err) => {
        console.warn("[Auth] getSession failed:", err);
        setLoading(false);
      });

    /**
     * NOT async, and it must never await a supabase call. This is the launch
     * hang — measured 2026-08-29, after three rounds of fixing things that were
     * not it.
     *
     * `_notifyAllSubscribers` does `await x.callback(event, session)` and then
     * `await Promise.all(...)` (GoTrueClient.js), so auth-js BLOCKS ON THIS
     * FUNCTION. The full cycle:
     *
     *   _initialize()                      <- this IS initializePromise
     *     await _recoverAndRefresh()
     *       await _callRefreshToken()      <- only when the token is near expiry
     *         await _saveSession()
     *         await _notifyAllSubscribers('TOKEN_REFRESHED')
     *           await <this callback>
     *             await fetchProfile()
     *               supabase.from('profiles')  -> _getAccessToken()
     *                 await auth.getSession()
     *                   await initializePromise   <- never resolves. deadlock.
     *
     * Nothing is slow. The measured launch had the refresh return HTTP 200 in
     * 871ms and every Keychain read under 10ms; the app then sat forever with
     * `profile.fetch` open and NO request ever issued, which is the signature —
     * the query never reached the network because it was waiting on the very
     * init that was waiting on it.
     *
     * Why it only bites after the app has been closed a while: the emit races
     * our subscription. With a fresh token `_recoverAndRefresh` emits SIGNED_IN
     * at ~10ms — before React has mounted and before this line runs — so there
     * are no subscribers and nothing to await. With a stale token the emit
     * happens AFTER the refresh round trip (~880ms), by which point this
     * callback is registered and becomes the thing init waits on. So the
     * network being healthy is what makes it hang: a refresh slow enough to
     * outlast mount is a refresh that deadlocks.
     *
     * And why force-quitting always "fixed" it: `_saveSession` runs BEFORE the
     * notify, so the refreshed token is already on disk. The next launch is the
     * fresh-token path, which emits before we subscribe.
     *
     * The deferral is the documented Supabase guidance — do not call other
     * supabase functions inside this callback; hand the work to a later task so
     * the callback returns immediately and init can finish.
     */
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      sessionRef.current = session;
      if (session) {
        // CLAIM the user id here, synchronously, then defer the work.
        //
        // Deferring made the double-fetch race non-deterministic. Previously
        // this callback awaited inline, so it and the getSession() path above
        // were strictly ordered. Now both can be in flight, and whichever runs
        // first is down to scheduling — which is exactly the concurrent
        // duplicate fetch `fetchingForRef` exists to prevent (and which the
        // root CLAUDE.md documents as a known hazard on this path).
        //
        // Claiming at SCHEDULE time rather than checking at RUN time makes it
        // deterministic again: the first of the two paths to reach its guard
        // owns the fetch and the other no-ops.
        if (fetchingForRef.current !== session.user.id) {
          fetchingForRef.current = session.user.id;
          setTimeout(() => fetchProfile(session.user.id), 0);
        }
      } else {
        profileRef.current = null;
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
    // `initAttempt` re-subscribes and re-reads the session on a manual retry.
  }, [initAttempt]);

  // Realtime: push profile changes (deactivation, deletion) to state immediately
  useEffect(() => {
    const userId = sessionRef.current?.user?.id;
    if (!userId) return;
    const channel = supabase
      .channel('profile-self-' + userId)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          // Merge, don't replace — correct under both answers to a question
          // we have NOT verified: whether Realtime's WAL filter applies the
          // subscribed role's column privileges. If it does, then once the
          // private columns are revoked (`.claude/notes/
          // g3-phone-column-revoke-plan.md`) `payload.new` arrives without
          // them, and a straight assignment would blank the user's own
          // phone/email a moment after any unrelated write to their row,
          // undoing what the definer RPC merged in. If it doesn't, merging is
          // a no-op. Deliberately not asserting which — an unverified claim
          // stated as fact in a comment is how 20260714's "execute granted
          // only to service_role" survived for months while anon could call it.
          //
          // A key that IS present still applies, null included, so this loses
          // no genuine clear.
          setProfile((prev) =>
            prev
              ? { ...prev, ...(payload.new as Partial<Profile>) }
              : (payload.new as Profile),
          );
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id]);

  /**
   * The columns withheld by 20260765, for the signed-in user only.
   *
   * Separate round trip because there is no way to ask for them alongside the
   * row — that is the entire point of withholding them. The function takes no
   * argument: the caller is auth.uid(), so there is nothing to aim at someone
   * else, the same shape as claim_guest_rides() replacing merge_guest_profile().
   *
   * A failure here must NOT fail the login. The user loses their own phone and
   * email from the profile screen until the next fetch; they do not lose the
   * app. Returns an empty object so the merge below is a no-op.
   */
  async function fetchPrivateFields(): Promise<Partial<Profile>> {
    // try/catch as well as the `error` check: a REJECTION and a returned
    // `{ error }` are different failure modes, and this function's contract is
    // that neither can fail the login. Without the catch a thrown RPC
    // propagates into fetchProfile's catch, which sets `threw` and — since the
    // profile is not committed until after this call — trips the
    // hold-the-gate branch below. Losing a phone number would take the whole
    // app down with it.
    try {
      const { data, error } = await supabase
        .rpc("my_private_profile")
        .maybeSingle();
      if (error) {
        console.log("[Auth] private profile fields unavailable:", error.message);
        return {};
      }
      return (data ?? {}) as Partial<Profile>;
    } catch (err) {
      console.warn("[Auth] private profile fields threw:", err);
      return {};
    }
  }

  /**
   * Both exits — the ref and the loading flag — are in a `finally`, and that is
   * the whole point of the shape.
   *
   * They used to be plain statements on the happy path, so anything that
   * *rejected* rather than returning `{ error }` (a fetch that never resolves
   * is one thing, a fetch that throws is another) skipped both. That left
   * `loading` true, which is a full-screen spinner with no exit, AND left
   * `fetchingForRef` pinned to this user id — which made the spinner
   * permanent rather than transient, because the early-return in
   * `onAuthStateChange` above (`if (fetchingForRef.current === session.user.id)
   * return;`) then discarded every later event for that user, TOKEN_REFRESHED
   * included. Nothing but a reload could clear it, which is exactly the
   * reported symptom: cold start hangs, force-quit and reopen is fine.
   *
   * The retry loop was never the culprit — it is bounded (10 x 600ms) and ends
   * by settling `loading`.
   */
  async function fetchProfile(userId: string, retries = 10) {
    fetchingForRef.current = userId;
    let threw = false;
    let netErr = false;

    try {
      // Bounded retry around the QUERY, distinct from the no-row retry below.
      // The two are different failures: no row is "the trigger has not fired
      // yet" (wait and re-ask), a throw is "the request did not complete"
      // (which the 20s /rest/v1/ ceiling in timeoutFetch made reachable where
      // before it just hung). A throw used to fall straight through to the
      // hold-the-gate branch in `finally` — a permanent spinner off a single
      // failed request, i.e. the same dead end as the original bug arriving
      // through a different door. Three attempts, then hold WITH the retry
      // affordance already showing rather than silently.
      let data: Awaited<ReturnType<typeof runQuery>>["data"] = null;
      let queryErr: unknown = null;

      const runQuery = () =>
        supabase
          .from("profiles")
          .select(PROFILE_COLUMNS)
          .eq("id", userId)
          .maybeSingle();

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await runQuery();
          data = res.data;
          queryErr = null;
          if (res.error) console.log("[Auth] profile query error:", res.error.message);
          break;
        } catch (e) {
          queryErr = e;
          console.warn(`[Auth] profile query threw (${attempt + 1}/3):`, e);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }

      if (queryErr) throw queryErr;

      // No row yet — retry (trigger hasn't fired or upsert pending)
      if (!data && retries > 0) {
        await new Promise((r) => setTimeout(r, 600));
        return await fetchProfile(userId, retries - 1);
      }

      // Row exists but no role yet — retry briefly (driver upsert may be in flight)
      if (data && !data.role && retries > 0) {
        await new Promise((r) => setTimeout(r, 600));
        return await fetchProfile(userId, retries - 1);
      }

      console.log("[Auth] profile settled:", data?.role ?? "none");
      // Merged HERE, not by the callers. fetchProfile and refetch are the only
      // two places a complete profile is constructed, and both go through this
      // shape on purpose: a bundle merged in anywhere else is dropped the next
      // time either one runs -- the same replace-clobbers-merge bug as the
      // realtime handler above, one door over.
      const merged = data ? { ...data, ...(await fetchPrivateFields()) } : null;
      profileRef.current = merged;
      setProfile(merged);
      // Clear here, not only in `retryConnection`. Recovery can arrive by
      // several routes — the auth subscriber, a foreground token refresh, the
      // manual button — and if `offline` only cleared on the one route that
      // happens to be `retryConnection`, the 4s timer below would keep running
      // for the life of the process behind a perfectly working app.
      setOffline(false);
    } catch (err) {
      // Deliberately does NOT clear `profile`: a transient failure on a later
      // refetch must not blank a profile that is already correct.
      console.warn("[Auth] profile fetch threw:", err);
      threw = true;
      // The common offline shape: the session read succeeded from disk, so we
      // are signed in, and only this query could not leave the phone. The gate
      // is held below (a driver must not land in the passenger app), so without
      // this it would sit on a spinner with no explanation.
      netErr = isNetworkError(err);
      if (netErr) setOffline(true);
    } finally {
      fetchingForRef.current = null;

      // Releasing the gate with a session but NO profile is not a safe
      // fallthrough, and this became reachable the moment the profile query
      // got a timeout: `RootNavigator` branches on `profile?.role === 'driver'`,
      // so a driver whose profile fetch failed lands in the PASSENGER app —
      // signed in, wrong role, wrong screen, and no indication anything went
      // wrong. Hold the gate instead and let the 30s watchdog offer Retry: a
      // bounded spinner with a way out beats silently handing someone the
      // wrong app.
      //
      // Only the THROW path holds. A clean query that legitimately returns no
      // row (a brand-new user whose profile row does not exist yet) still
      // releases, because that is a real state the app knows how to render.
      const stuckWithoutProfile =
        threw && !!sessionRef.current && !profileRef.current;

      if (!loadingHeldRef.current && !stuckWithoutProfile) {
        setLoading(false);
      } else if (stuckWithoutProfile && !netErr) {
        // Show the way out IMMEDIATELY rather than making the user sit through
        // the 30s watchdog for a failure we already know about.
        //
        // Skipped when the cause is connectivity: `offline` already renders a
        // truthful message and retries on its own, and "this is taking longer
        // than usual" alongside it would be both redundant and vaguer. The gate is
        // still held on purpose (see above — a driver must not be dropped into
        // the passenger app), but "held" must never mean "held silently".
        setStalled(true);
      }
    }
  }

  async function refetch() {
    const userId = sessionRef.current?.user?.id;
    if (!userId) return;
    const { data } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (data) {
      const merged = { ...data, ...(await fetchPrivateFields()) };
      profileRef.current = merged;
      setProfile(merged);
      setLoading(false);
    }
  }

  async function signOut() {
    loadingHeldRef.current = false;
    const userId = sessionRef.current?.user?.id;
    if (profile?.role === "driver" && userId) {
      // Clear local token before nulling DB so the Realtime handler doesn't
      // mistake a deliberate sign-out for a kicked-out-by-another-device event.
      const localToken = await getDeviceToken();
      await clearDeviceToken();
      // Compare-and-clear. A device being kicked out runs this same path, and
      // by then the NEW device has already written its own device_token — an
      // unconditional null would wipe the incoming session's claim and leave
      // the account unlocked. Only surrender the token if it is still ours.
      if (localToken) {
        await supabase
          .from("drivers")
          .update({ device_token: null })
          .eq("id", userId)
          .eq("device_token", localToken);
      }
    }
    // scope:'local' — supabase-js defaults to 'global', which deletes EVERY
    // auth.sessions row for the user, on every device. That is what made the
    // single-device lock destructive: the old device's kick-out revoked the
    // new device's session too, and because PostgREST validates a JWT locally
    // (signature + exp only, never auth.sessions) neither app noticed. They
    // kept reading, writing and heartbeating on orphaned tokens, and the only
    // thing that broke was GoTrue's /user endpoint — i.e. exactly the two
    // functions that call getUser(): capture-payment and create-payment-intent.
    // Signing out means signing out THIS device.
    await supabase.auth.signOut({ scope: "local" });
    profileRef.current = null;
    setProfile(null);
    sessionRef.current = null;
    fetchingForRef.current = null;
  }

  function holdLoading() {
    loadingHeldRef.current = true;
    setLoading(true);
  }

  function releaseLoading() {
    loadingHeldRef.current = false;
  }

  return (
    <AuthContext.Provider
      value={{ session, profile, loading, stalled, offline, retryInit, retryConnection, signOut, refetch, holdLoading, releaseLoading }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
