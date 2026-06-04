export type UserRole = 'passenger' | 'driver' | 'admin'

export interface Profile {
  id: string
  name: string | null
  phone: string | null
  role: UserRole
  avatar_url: string | null
  deleted_at: string | null
  created_at: string
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