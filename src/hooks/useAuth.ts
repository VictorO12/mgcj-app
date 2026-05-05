import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { Profile } from '../types'
import { Session } from '@supabase/supabase-js'

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setSession(session)
        if (session) await fetchProfile(session.user.id)
        else { setProfile(null); setLoading(false) }
      }
    )
    return () => subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId: string, retries = 5) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if ((error || !data) && retries > 0) {
      // Row not ready yet — wait 500ms and retry
      await new Promise(r => setTimeout(r, 500))
      return fetchProfile(userId, retries - 1)
    }

    setProfile(data ?? null)
    setLoading(false)
  }

  async function signOut() {
    await supabase.auth.signOut()
    setProfile(null)
  }

  return { session, profile, loading, signOut }
}
