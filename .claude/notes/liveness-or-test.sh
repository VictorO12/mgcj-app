#!/usr/bin/env bash
# TEST 2: does PostgREST AND-combine TWO chained .or() filters?
#
# scheduled-release builds exactly this shape:
#   .or(livenessOrFilter())                                   -> or=(last_seen_at...)
#   .or('vehicle_class_id.eq.X,vehicle_class_id.is.null')     -> or=(vehicle_class_id...)
# Confirmed both params are emitted separately. If PostgREST let the second
# REPLACE the first, a class-restricted release would silently drop the
# liveness filter and offer rides to phantom drivers.
#
# Table-independent, so it uses `drivers` purely as a row source. Needs the
# service-role key (RLS hides every row from anon).
#
# Run:  SERVICE_KEY=<service_role key> bash .claude/notes/liveness-or-test.sh
#
# RESULT 2026-08-23 -- PASS: C=5, A=0, B=0. PostgREST AND-combines repeated
# `or=` params, so the liveness filter and the vehicle-class filter both apply
# on a class-restricted release. The control (C) is what makes A=0 and B=0
# meaningful -- a bad key, a malformed request or an empty table would also
# produce A=0, and would look identical to a pass.

U="https://hhsqwmftrrmtodvvuyxq.supabase.co"
K="${SERVICE_KEY:?paste the service_role key: SERVICE_KEY=... bash $0}"
q() { curl -s "$U/rest/v1/drivers?select=id&limit=5&$1" -H "apikey: $K" -H "Authorization: Bearer $K" \
     | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else d)"; }

echo "C control  (true  AND true )  expect >0 : $(q 'or=(id.not.is.null)&or=(id.not.is.null)')"
echo "A          (FALSE AND true )  expect  0 : $(q 'or=(id.is.null)&or=(id.not.is.null)')"
echo "B          (true  AND FALSE)  expect  0 : $(q 'or=(id.not.is.null)&or=(id.is.null)')"
echo
echo "C>0, A=0, B=0  -> AND-combined. The chained .or() is safe."
echo "A>0            -> last-one-wins: the liveness filter is being DROPPED on"
echo "                  class-restricted rides. Real bug, fix scheduled-release."
echo "B>0            -> first-one-wins: the class filter is being dropped."
