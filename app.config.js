export default {
  name: "M&G C&J",
  slug: "mgcj-app",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
    resizeMode: "contain",
    backgroundColor: "#111827",
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: "com.mgcj.app",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
    config: { googleMapsApiKey: process.env.GOOGLE_MAPS_IOS_KEY },
  },
  android: {
    package: "com.mgcj.app",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#111827",
    },
    config: { googleMaps: { apiKey: process.env.GOOGLE_MAPS_KEY } },
  },
  plugins: [
    [
      "expo-notifications",
      {
        icon: "./assets/icon.png",
        color: "#E8500A",
      },
    ],
    [
      "@stripe/stripe-react-native",
      {
        merchantIdentifier: "merchant.com.mgcj.app",
        enableGooglePay: false,
      },
    ],
  ],
  extra: {
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    googleMapsRoutingKey: process.env.GOOGLE_MAPS_ROUTING_KEY,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    eas: {
      projectId: "1df2c110-8290-4853-9574-2fe4b71799b0",
    },
  },
};
