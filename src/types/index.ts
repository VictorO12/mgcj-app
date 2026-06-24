export type UserRole = 'passenger' | 'driver' | 'admin'

export interface Profile {
  id: string
  name: string | null
  phone: string | null
  role: UserRole
  company_id: string | null
  avatar_url: string | null
  deleted_at: string | null
  created_at: string
  student_verified: boolean
  student_email: string | null
  student_institution_id: string | null
  student_verified_at: string | null
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