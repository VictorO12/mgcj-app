/**
 * Launch instrumentation. TEMPORARY — see "Removing this" at the bottom.
 *
 * Three rounds of fixes for the launch hang were aimed at causes that were
 * reasoned about rather than measured, and each one fixed something real that
 * turned out not to be the bug. This module exists so the fourth round starts
 * from a number instead of an argument.
 *
 * The question it has to answer is narrow: WHICH await is slow, and is it slow
 * once or slow always. Those have different fixes and are indistinguishable
 * from the outside — both present as a spinner.
 *
 *   storage read slow, fetch fast .... Keychain; a ceiling on the adapter fixes it
 *   refresh slow, profile fast ....... connection warm-up; optimistic launch is a
 *                                      COMPLETE fix, because only the first
 *                                      request pays
 *   both requests slow ............... systemic; caching hides the spinner but the
 *                                      app is still deaf for 40s, which for a
 *                                      driver is worse than an honest spinner
 *   fetch ISSUED late, completes fast  neither — the delay is before the network
 *
 * The boot path conveniently makes two requests back to back (the token
 * refresh, then the profile query), so first-vs-all falls out of one launch
 * with no extra work.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Module-load time, which is as close to process start as JS can see. Every
 * mark is relative to this, so the numbers read as "how far into the launch",
 * not as wall-clock.
 */
const T0 = Date.now();

export type Mark = { at: number; label: string; detail?: string };

const marks: Mark[] = [];
const spans = new Map<string, number>();
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // A broken listener must never be able to break the thing it observes.
    }
  });
};

export const sinceBoot = () => Date.now() - T0;

export function mark(label: string, detail?: string) {
  marks.push({ at: sinceBoot(), label, detail });
  emit();
}

/** Opens a span. `spanEnd` with the same name closes it and records duration. */
export function spanStart(name: string, detail?: string) {
  spans.set(name, Date.now());
  marks.push({ at: sinceBoot(), label: `${name} …`, detail });
  emit();
}

export function spanEnd(name: string, detail?: string) {
  const started = spans.get(name);
  spans.delete(name);
  const ms = started === undefined ? undefined : Date.now() - started;
  marks.push({
    at: sinceBoot(),
    label: name,
    detail: [ms !== undefined ? `${ms}ms` : undefined, detail]
      .filter(Boolean)
      .join("  "),
  });
  emit();
}

export function getMarks(): Mark[] {
  return marks;
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function formatTrace(): string[] {
  return marks.map(
    (m) =>
      `+${(m.at / 1000).toFixed(2)}s  ${m.label}${m.detail ? `  ${m.detail}` : ""}`,
  );
}

const LAST_TRACE_KEY = "boot.lastTrace";

/**
 * Persisted because the interesting launch is often the one you CANNOT read:
 * if the gate releases in 6s the trace is gone before it can be screenshotted,
 * and 6s is still far too slow — it just isn't slow enough to sit and stare at.
 * Writing it means the next launch can show what the previous one did.
 */
export function persistTrace() {
  AsyncStorage.setItem(
    LAST_TRACE_KEY,
    JSON.stringify({ total: sinceBoot(), lines: formatTrace() }),
  ).catch(() => {
    // Diagnostics must never be able to fail a launch.
  });
}

export async function loadPreviousTrace(): Promise<{
  total: number;
  lines: string[];
} | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_TRACE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Removing this: delete this file, the `bootTrace` imports in supabase.ts,
 * timeoutFetch.ts, AuthContext.tsx and App.tsx, and the <BootTrace/> block in
 * App.tsx. Nothing else depends on it — it is deliberately write-only from the
 * app's point of view, so it cannot change behaviour on the way out.
 */
