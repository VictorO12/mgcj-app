export default {
  name: "Vellon Dispatch",
  slug: "mgcj-app",
  scheme: "mgcjapp",
  version: "1.0.0",
  // OTA updates. `fingerprint` policy: the runtime version changes automatically
  // when native deps/config change, so a JS bundle can never land on a binary
  // that lacks a native module it calls. Do NOT switch to the `appVersion`
  // policy — bumping `version` above would orphan every installed build.
  runtimeVersion: { policy: "fingerprint" },
  updates: {
    url: "https://u.expo.dev/1df2c110-8290-4853-9574-2fe4b71799b0",
    // Block at the native splash for up to 4s to fetch and launch the NEW bundle,
    // so a launch-crash fix applies on the FIRST relaunch, before the crashing JS
    // ever runs. `0` (launch from cache, download in the background) is the
    // setting LEAST able to handle a launch crash — the crash races the download
    // and usually wins — and a launch crash is the exact incident this exists for.
    // Cost is up to 4s of cold start on a bad network; on timeout it falls back to
    // the cached bundle and keeps downloading. Do not set this to 0.
    fallbackToCacheTimeout: 4000,
  },
  orientation: "portrait",
  userInterfaceStyle: "automatic",
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
    "@react-native-community/datetimepicker",
    "expo-web-browser",
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
