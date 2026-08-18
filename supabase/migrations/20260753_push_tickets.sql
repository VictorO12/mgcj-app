-- Push receipts / DeviceNotRegistered  (see .claude/notes/push-receipts-devicenotregistered.md)
--
-- Sending an Expo push is two phases and we only ever used the first. A TICKET is
-- returned synchronously by /push/send and means "Expo accepted the payload". A
-- RECEIPT is fetched later and means "Expo handed it to APNs/FCM, here's what
-- happened". DeviceNotRegistered appears in both, but a token that was valid and
-- then DIED -- app uninstalled, reinstalled, or notifications revoked in OS
-- settings -- reports it only in the RECEIPT. That is why checking tickets alone
-- does not fix this: scheduled-ride-digest has inspected tickets since
-- 2026-08-15 and dead tokens still accumulate.
--
-- A dead token is indistinguishable from a live one, and isDriverDispatchable()
-- is (live AND push_token IS NOT NULL) -- so a phantom passes every filter, gets
-- offered rides that never reach their phone, and times out at 60s while the
-- dashboard reads "covered".

-- ── Ticket parking lot ──────────────────────────────────────────────────────
-- Deliberately minimal: no payload, no user id. One row per push SEND, and
-- scheduled-release runs every 2 minutes, so this table's growth is the
-- cron.job_run_details lesson pre-registered. Expo drops receipts after 24h, so
-- a row older than that is UNPOLLABLE BY DEFINITION -- rows are deleted as soon
-- as they're polled, plus a 24h sweep for stragglers.
--
-- token_sent is stored (rather than a user id) because retirement matches on the
-- token VALUE -- see retire_push_token below.
CREATE TABLE push_tickets (
  ticket_id  text PRIMARY KEY,
  token_sent text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_tickets_created_at_idx ON push_tickets (created_at);

-- Internal plumbing: only the service role ever touches this. No policies are
-- defined, so RLS denies anon/authenticated outright. Grants are explicit per the
-- post-2026-10-30 Data API rule.
ALTER TABLE push_tickets ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON push_tickets TO service_role;

-- ── Retiring a dead token ───────────────────────────────────────────────────
-- Matches on the token VALUE, never on a user id, and this is load-bearing.
--
-- The race: a passenger replaces their phone. The new device signs in and
-- overwrites push_token immediately, but the OLD device's dead token can still
-- produce a DeviceNotRegistered receipt that lands AFTER that. Keyed by user id,
-- that late receipt would wipe the NEW, WORKING token and silently kill push for
-- someone who did nothing wrong. Keyed by value, the WHERE simply matches nothing
-- and the new token survives. Do not "simplify" this to a user id.
--
-- The is_active flip: a driver whose token is dead cannot be dispatched at all
-- (isDriverDispatchable requires a token), so leaving them is_active = true shows
-- them a green "online" status that is a lie while offers silently stop. Flipping
-- it drops them into the existing go-online gate, which already requires
-- registerPushToken() and already deep-links to OS settings when the permission
-- was revoked -- reusing the recovery path rather than inventing a signal.
--
-- Note the asymmetry with reap_stale_drivers: nulling the TOKEN is correct even
-- mid-ride (the device genuinely cannot receive), but is_active must not be
-- flipped under a driver on an active ride -- their heartbeat feeds the
-- passenger's ETA. Don't copy the reaper's guard onto both halves.
CREATE OR REPLACE FUNCTION retire_push_token(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RETURN;
  END IF;

  -- Everyone carries the token on profiles (notify-passenger reads it here).
  UPDATE profiles
     SET push_token = NULL
   WHERE push_token = p_token;

  -- Drivers carry a second copy on drivers (dispatch reads it here).
  UPDATE drivers d
     SET push_token = NULL,
         is_active = CASE
           WHEN EXISTS (
             SELECT 1 FROM rides r
              WHERE r.driver_id = d.id
                AND r.status IN ('assigned', 'driver_arriving', 'in_progress')
           ) THEN d.is_active   -- mid-ride: leave them online
           ELSE false           -- otherwise drop them into the go-online gate
         END
   WHERE d.push_token = p_token;
END;
$$;

-- Service-role only. `REVOKE FROM public` alone is NOT enough: Supabase default
-- privileges grant EXECUTE directly to anon and authenticated, so a definer
-- function stays callable via PostgREST until those two are revoked BY NAME.
-- (Verified against the live DB when reap_stale_drivers was added.)
REVOKE EXECUTE ON FUNCTION retire_push_token(text) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION retire_push_token(text) TO service_role;
