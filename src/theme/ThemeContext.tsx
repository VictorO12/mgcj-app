import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useMemo,
  useCallback,
} from "react";
import { Appearance, AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { darkColors, lightColors, type Colors } from "./colors";

export type ThemeMode = "system" | "light" | "dark";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme_preference";

interface ThemeContextType {
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  colors: Colors;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");
  const [systemScheme, setSystemScheme] = useState<ResolvedTheme>(
    Appearance.getColorScheme() === "light" ? "light" : "dark",
  );

  // Load the persisted preference once. No loading gate — we already have
  // a usable theme (system) from the very first render, so there's nothing
  // to block on; this just corrects to the saved override when it arrives.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") {
        setThemeModeState(stored);
      }
    });
  }, []);

  // Only listen for OS theme changes while following the system setting.
  useEffect(() => {
    if (themeMode !== "system") return;
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme === "light" ? "light" : "dark");
    });
    // Appearance's change event is unreliable while the app stays foregrounded
    // (notably in Expo Go) — re-sync from the OS whenever the app resumes,
    // since the system setting may have changed while we were backgrounded.
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        setSystemScheme(
          Appearance.getColorScheme() === "light" ? "light" : "dark",
        );
      }
    });
    return () => {
      sub.remove();
      appStateSub.remove();
    };
  }, [themeMode]);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    AsyncStorage.setItem(STORAGE_KEY, mode);
  }, []);

  const resolvedTheme: ResolvedTheme =
    themeMode === "system" ? systemScheme : themeMode;

  const colors = useMemo(
    () => (resolvedTheme === "dark" ? darkColors : lightColors),
    [resolvedTheme],
  );

  const value = useMemo(
    () => ({ themeMode, resolvedTheme, colors, setThemeMode }),
    [themeMode, resolvedTheme, colors, setThemeMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
