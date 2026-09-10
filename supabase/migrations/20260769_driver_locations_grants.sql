-- Make 20260768's grant comment true.
--
-- That migration said "No UPDATE and no DELETE to anyone" and issued
-- `GRANT SELECT, INSERT ON driver_locations TO authenticated`. The post-apply
-- check showed anon AND authenticated holding DELETE, INSERT, REFERENCES,
-- SELECT, TRIGGER, TRUNCATE and UPDATE — because Supabase's ALTER DEFAULT
-- PRIVILEGES had already granted ALL on the new table to both roles. Adding a
-- narrower GRANT does not narrow anything: privileges are additive. The only
-- way to a list is to revoke first and re-grant.
--
-- Nothing was exploitable through PostgREST in the meantime — there are no
-- UPDATE/DELETE policies, so RLS denied both, and TRUNCATE is not reachable
-- over the REST API. But that means immutability was resting on the ABSENCE of
-- a policy, one layer deep, on the one table whose entire product value is that
-- its contents can be trusted. Two layers is the point.
--
-- Note TRUNCATE specifically: Postgres does NOT apply row-level security to it.
-- A role holding TRUNCATE on this table is not restrained by RLS at all, only
-- by having no way to issue the statement.

REVOKE ALL ON driver_locations FROM anon, authenticated;

-- Re-grant the list, and only the list. anon gets nothing: an anonymous
-- guest-booking session has no business anywhere near driver history.
GRANT SELECT, INSERT ON driver_locations TO authenticated;

-- Revoked along with ALL above; the client needs it back for nextval on INSERT.
GRANT USAGE, SELECT ON SEQUENCE driver_locations_id_seq TO authenticated;
