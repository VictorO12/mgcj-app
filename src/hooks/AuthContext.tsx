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
          setProfile(payload.new as Profile);
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id]);

  async function fetchProfile(userId: string, retries = 10) {
    fetchingForRef.current = userId;

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
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
    setProfile(data ?? null);
    if (!loadingHeldRef.current) {
      setLoading(false);
    }
  }

  async function refetch() {
    const userId = sessionRef.current?.user?.id;
    if (!userId) return;
    const { data } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();
    if (data) {
      setProfile(data);
      setLoading(false);
    }
  }

  async function signOut() {
    loadingHeldRef.current = false;
    await supabase.auth.signOut();
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
