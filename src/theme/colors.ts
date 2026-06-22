export interface Colors {
  background: string;
  backgroundOverlay: string;
  surface: string;
  surfaceOverlay: string;
  surfaceAlt: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textMuted: string;
  textFaint: string;
  textOnSurfaceLight: string;
  avatarText: string;
  border: string;
  borderSubtle: string;
  borderStrong: string;
  modalOverlay: string;

  accentOrange: string;
  accentGreen: string;
  accentAmber: string;
  accentAmberText: string;
  accentPurple: string;
  accentPurpleDeep: string;
  accentBlue: string;
  accentRed: string;
  accentRedDeep: string;
  accentRedAlarm: string;

  accentPurpleTextStrong: string;
  accentPurpleTextSubtle: string;
  surfacePurpleTint: string;
  surfaceOrangeTint: string;
}

const accentTokens = {
  accentOrange: "#E8500A",
  accentGreen: "#1D9E75",
  accentAmber: "#F59E0B",
  accentAmberText: "#D97706",
  accentPurple: "#A855F7",
  accentPurpleDeep: "#7C3AED",
  accentBlue: "#4a9eff",
  accentRed: "#F87171",
  accentRedDeep: "#E24B4A",
  accentRedAlarm: "#EF4444",
};

export const darkColors: Colors = {
  background: "#111827",
  backgroundOverlay: "rgba(17,24,39,0.92)",
  surface: "#1E2A3A",
  surfaceOverlay: "rgba(30,42,58,0.92)",
  surfaceAlt: "#1E3A5F",
  textPrimary: "#F1F5F9",
  textSecondary: "#6B7280",
  textTertiary: "#9CA3AF",
  textMuted: "#4B5563",
  textFaint: "#374151",
  textOnSurfaceLight: "#CBD5E1",
  avatarText: "#93C5FD",
  border: "rgba(255,255,255,0.08)",
  borderSubtle: "rgba(255,255,255,0.05)",
  borderStrong: "rgba(255,255,255,0.12)",
  modalOverlay: "rgba(0,0,0,0.6)",

  ...accentTokens,

  accentPurpleTextStrong: "#E9D5FF",
  accentPurpleTextSubtle: "#C084FC",
  surfacePurpleTint: "#2D1B4E",
  surfaceOrangeTint: "#2A1A0E",
};

export const lightColors: Colors = {
  background: "#F7F8FA",
  backgroundOverlay: "rgba(247,248,250,0.92)",
  surface: "#FFFFFF",
  surfaceOverlay: "rgba(255,255,255,0.92)",
  surfaceAlt: "#E6EEF7",
  textPrimary: "#0F172A",
  textSecondary: "#4B5563",
  textTertiary: "#5B6472",
  textMuted: "#64748B",
  textFaint: "#CBD5E1",
  textOnSurfaceLight: "#475569",
  avatarText: "#1D4ED8",
  border: "rgba(15,23,42,0.08)",
  borderSubtle: "rgba(15,23,42,0.05)",
  borderStrong: "rgba(15,23,42,0.12)",
  modalOverlay: "rgba(15,23,42,0.45)",

  ...accentTokens,

  accentPurpleTextStrong: "#7C3AED",
  accentPurpleTextSubtle: "#9333EA",
  surfacePurpleTint: "#F3E8FF",
  surfaceOrangeTint: "#FFF1E6",
};
