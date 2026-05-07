import React, { createContext, useContext, useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import type { Profile } from '../types'
import type { Session } from '@supabase/supabase-js'

interface AuthContextType {
  session: Session | null
  profile: Profile | null
  loading: boolean
  signOut: () => Promise<void>
  refetch: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<Session | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      sessionRef.current = session
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session)
        sessionRef.current = session
        if (session) await fetchProfile(session.user.id)
        else { setProfile(null); setLoading(false) }
      }
    )

    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId: string, retries = 15) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if ((error || !data) && retries > 0) {
      await new Promise(r => setTimeout(r, 500))
      return fetchProfile(userId, retries - 1)
    }

    if ((!data?.role || data?.role === 'passenger') && retries > 5) {
      await new Promise(r => setTimeout(r, 500))
      return fetchProfile(userId, retries - 1)
    }

    console.log('[Auth] profile settled:', data?.role)
    setProfile(data ?? null)
    setLoading(false)
  }

  // Single shared refetch — updates the ONE profile state that controls routing
  async function refetch() {
    const currentSession = sessionRef.current
    if (!currentSession?.user?.id) {
      console.log('[Auth] refetch called but no session')
      return
    }
    console.log('[Auth] refetching profile for:', currentSession.user.id)
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', currentSession.user.id)
      .single()
    console.log('[Auth] refetch result:', data?.role, error)
    if (data) {
      setProfile(data)
      setLoading(false)
    }
  }

  async function signOut() {
    await supabase.auth.signOut()
    setProfile(null)
    sessionRef.current = null
  }

  return (
    <AuthContext.Provider value={{ session, profile, loading, signOut, refetch }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
