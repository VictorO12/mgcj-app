import AsyncStorage from "@react-native-async-storage/async-storage";

// TEMPORARY DIAGNOSTIC — added 2026-09-10 to find the locked-phone blackout
// (see .claude/notes/background-location-shift-tracking.md). Delete once the
// cause is settled.
//
// Written to AsyncStorage rather than logged, on purpose: the whole question is
// what happens in a headless background context with no console attached, a
// possibly-dead session and possibly no network. A diary entry must survive all
// three, so it can use none of them.
//
// The load-bearing property is that an EMPTY diary is itself the answer. If the
// task never enters, nothing here records anything, and "no entries across a
// locked walk" is the proof that iOS is not running our JS at all — which no
// amount of auth work would fix.

const DIARY_KEY = "driver.location.diary";
// ~3 entries per fix. A 20-minute locked walk at the 25m ride cadence is around
// 60 fixes, so 200 would only just cover the window under test — and the entries
// that roll off would be the earliest, which is where the story starts.
const MAX_ENTRIES = 400;

export type DiaryEntry = {
  at: number;
  step: string;
  detail?: string;
};

// Same read-modify-write hazard as the breadcrumb buffer: the task can fire
// again while a previous append is awaiting.
let queue: Promise<unknown> = Promise.resolve();

export async function noteTaskEvent(step: string, detail?: string): Promise<void> {
  const next = queue.then(async () => {
    try {
      const raw = await AsyncStorage.getItem(DIARY_KEY);
      const rows: DiaryEntry[] = raw ? JSON.parse(raw) : [];
      rows.push({ at: Date.now(), step, detail });
      const trimmed = rows.length > MAX_ENTRIES ? rows.slice(rows.length - MAX_ENTRIES) : rows;
      await AsyncStorage.setItem(DIARY_KEY, JSON.stringify(trimmed));
    } catch {
      // A diagnostic must never be able to break the thing it is diagnosing.
    }
  });
  queue = next.catch(() => {});
  return next;
}

export async function readTaskDiary(): Promise<DiaryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(DIARY_KEY);
    return raw ? (JSON.parse(raw) as DiaryEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearTaskDiary(): Promise<void> {
  try {
    await AsyncStorage.removeItem(DIARY_KEY);
  } catch {
    // Best effort.
  }
}
