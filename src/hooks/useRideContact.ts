import { useState, useEffect, useCallback } from "react";
import { Alert, Linking } from "react-native";
import { invokeFunction } from "../lib/invokeFunction";
import { RIDE_CHAT_LIVE_STATUSES } from "./useRideThread";

/**
 * The masked phone line for one ride — G3 Phase 2.
 *
 * Design: .claude/notes/G3-phase2-masked-telephony-plan.md
 *
 * ── The invariant this hook exists to enforce ─────────────────────────────
 * Neither party ever holds the other's real number. Before Phase 2 the call
 * buttons read `ride.driver?.phone` / `ride.passenger_phone` and handed it
 * straight to `tel:` — so the number was already in the component, already on
 * the device, and one screenshot away from permanent.
 *
 * Now the number comes from the server, per-caller, and it is a PROXY number.
 * The real one is never fetched, so there is nothing in this component to leak.
 * That is the point of the shape, not a side effect of it: keep it that way,
 * and never pass a real phone number into this hook "as a fallback".
 *
 * ── Fail closed ───────────────────────────────────────────────────────────
 * No session -> `canContact` is false -> the caller renders NO button. Pool
 * exhausted, telephony down, window elapsed: all the same answer. There is
 * deliberately no branch anywhere in this file that falls back to a real
 * number; a fallback that reveals one has failed at the only thing the feature
 * does. The correct escalation is dispatch.
 */

export type ContactReason =
  | "no_driver"      // nobody assigned yet — the ordinary early state
  | "no_session"     // driver assigned but no line (pool exhausted / Twilio down)
  | "window_closed"  // the 2h post-ride grace has elapsed
  | "no_number"
  | "error";

interface ContactState {
  canContact: boolean;
  callNumber: string | null;
  smsNumber: string | null;
  expiresAt: string | null;
  reason: ContactReason | null;
  loading: boolean;
}

const CLOSED: Omit<ContactState, "loading"> = {
  canContact: false,
  callNumber: null,
  smsNumber: null,
  expiresAt: null,
  reason: null,
};

export function useRideContact(rideId: string | null | undefined, status?: string | null) {
  const [state, setState] = useState<ContactState>({ ...CLOSED, loading: false });

  const refresh = useCallback(async () => {
    if (!rideId) {
      setState({ ...CLOSED, loading: false });
      return;
    }

    // Pre-flight skip, for the list case: AssignedRidesListScreen renders this
    // hook once per card, over a list that is almost entirely open and offered
    // rides with no driver committed, and asking the server about each is a
    // guaranteed round trip to "no".
    //
    // It skips ONLY statuses that can never have a session. 'completed' is
    // deliberately NOT one of them, and the distinction is the whole point of
    // this comment: the first version of this gate called
    // rideAcceptsMessages(status, completedAt), which is the correct predicate
    // but which every call site invoked without a completedAt — so a completed
    // ride evaluated false and short-circuited to "window_closed" while the
    // line was still live at Twilio for another two hours. The button would
    // simply be absent, with no error, for precisely the "I left my bag in the
    // car" case that D4 exists to serve.
    //
    // So the rule here is narrower than the real window on purpose: it answers
    // only "could this possibly have a session", and anything inside the grace
    // window goes to the server, which is the authority and knows expires_at.
    // A false positive costs one wasted request. A false negative costs a
    // passenger their driver.
    if (status && !RIDE_CHAT_LIVE_STATUSES.includes(status) && status !== "completed") {
      setState({ ...CLOSED, reason: "no_driver", loading: false });
      return;
    }

    setState((s) => ({ ...s, loading: true }));

    const { data, error } = await invokeFunction("ride-contact", { ride_id: rideId });

    if (error || !data) {
      // An error is not a reason to show a number. Closed is the safe state and
      // it is also the honest one — if we cannot reach the server we do not
      // know whether a line exists.
      setState({ ...CLOSED, reason: "error", loading: false });
      return;
    }

    setState({
      canContact: !!data.can_contact,
      callNumber: data.call_number ?? null,
      smsNumber: data.sms_number ?? null,
      expiresAt: data.expires_at ?? null,
      reason: data.can_contact ? null : (data.reason ?? "error"),
      loading: false,
    });
  }, [rideId, status]);

  // Re-resolve when the ride changes hands or moves through its lifecycle: the
  // session is closed and reopened on a driver change (Twilio caps a session at
  // two participants and will not let one be swapped in place), so the number
  // the passenger should dial is not stable across the life of a ride.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const call = useCallback(() => {
    if (!state.callNumber) return;
    Linking.openURL(`tel:${state.callNumber}`).catch(() => {
      Alert.alert("Couldn't start the call", "Please try again.");
    });
  }, [state.callNumber]);

  // Native SMS to the proxy number — no server round trip. The driver's handset
  // texts the proxy, Twilio routes it to the passenger's real handset, and the
  // passenger sees only the proxy number. This is what reaches the guest
  // passengers dispatch books by phone with no app installed (§7): the single
  // strongest argument for building the telephony half at all, and the one
  // population in-app chat structurally cannot serve.
  const text = useCallback(() => {
    if (!state.smsNumber) return;
    Linking.openURL(`sms:${state.smsNumber}`).catch(() => {
      Alert.alert("Couldn't open messages", "Please try again.");
    });
  }, [state.smsNumber]);

  return { ...state, call, text, refresh };
}
