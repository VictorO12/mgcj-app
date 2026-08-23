export type UserRole = 'passenger' | 'driver' | 'admin'

export interface Profile {
  id: string
  name: string | null
  role: UserRole
  company_id: string | null
  avatar_url: string | null
  is_active: boolean
  deactivation_pending: boolean
  deleted_at: string | null
  created_at: string
  student_verified: boolean
  student_institution_id: string | null
  student_verified_at: string | null

  /**
   * Withheld columns (20260765): not selectable from `profiles` by the client
   * roles at all, so they are absent on the row and merged in from
   * my_private_profile() — for the signed-in user ONLY. Optional because that
   * merge can legitimately not have happened: the RPC failing must not fail the
   * login. Never populated for anyone other than yourself; a counterparty's
   * number comes from useRideContact's masked line, never from here.
   */
  phone?: string | null
  email?: string | null
  student_email?: string | null
  stripe_customer_id?: string | null
  push_token?: string | null
  notification_prefs: {
    ride_updates: boolean
    pickup_reminders: boolean
  }
}

export type RootStackParamList = {
  Welcome: undefined
  PhoneEntry: undefined
  SignUp: undefined
  DriverWelcome: undefined
  DriverSignUp: undefined
  OTPVerify: {
    phone: string
    name?: string
    isNewUser: boolean
    isDriver?: boolean
    inviteCode?: string
  }
  PassengerHome: undefined
  DriverHome: undefined
}