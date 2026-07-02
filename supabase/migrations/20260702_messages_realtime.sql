-- New tables aren't auto-added to the realtime publication (same gotcha as the
-- Data API grants convention) — client-side postgres_changes subscriptions on
-- messages were silently no-op-ing without this, even though the push-notification
-- webhook worked fine since it doesn't depend on this publication.
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
