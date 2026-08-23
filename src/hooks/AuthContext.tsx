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

interface AuthContextType {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionRef = useRef<Session | null>(null);
  const fetchingForRef = useRef<string | null>(null);
  const loadingHeldRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      sessionRef.current = session;
      if (session) fetchProfile(session.user.id);
      else setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      sessionRef.current = session;
      if (session) {
        // Avoid double-fetching if already fetching for this user
        if (fetchingForRef.current === session.user.id) return;
        await fetchProfile(session.user.id);
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

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
    const { data, error } = await supabase
      .rpc("my_private_profile")
      .maybeSingle();
    if (error) {
      console.log("[Auth] private profile fields unavailable:", error.message);
      return {};
    }
    return (data ?? {}) as Partial<Profile>;
  }

  async function fetchProfile(userId: string, retries = 10) {
    fetchingForRef.current = userId;

    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", userId)
      .maybeSingle();

    // No row yet — retry (trigger hasn't fired or upsert pending)
    if (!data && retries > 0) {
      await new Promise((r) => setTimeout(r, 600));
      return fetchProfile(userId, retries - 1);
    }

    // Row exists but no role yet — retry briefly (driver upsert may be in flight)
    if (data && !data.role && retries > 0) {
      await new Promise((r) => setTimeout(r, 600));
      return fetchProfile(userId, retries - 1);
    }

    fetchingForRef.current = null;
    console.log("[Auth] profile settled:", data?.role ?? "none");
    // Merged HERE, not by the callers. fetchProfile and refetch are the only
    // two places a complete profile is constructed, and both go through this
    // shape on purpose: a bundle merged in anywhere else is dropped the next
    // time either one runs -- the same replace-clobbers-merge bug as the
    // realtime handler above, one door over.
    setProfile(data ? { ...data, ...(await fetchPrivateFields()) } : null);
    if (!loadingHeldRef.current) {
      setLoading(false);
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
      setProfile({ ...data, ...(await fetchPrivateFields()) });
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
      value={{ session, profile, loading, signOut, refetch, holdLoading, releaseLoading }}
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
