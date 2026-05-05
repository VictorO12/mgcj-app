export type UserRole = 'passenger' | 'driver' | 'admin'

export interface Profile {
  id: string
  name: string | null
  phone: string | null
  role: UserRole
  created_at: string
}

export type RootStackParamList = {
  PhoneEntry: undefined
  OTPVerify: { phone: string }
  PassengerHome: undefined
  DriverHome: undefined
}
