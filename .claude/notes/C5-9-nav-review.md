# C 5-9.MP4 — driver navigation review

Recording: 7:06, iPhone portrait, 2026-08-09 ~8:36–8:43 PM.
Flow: online → scheduled offer accepted (t≈60s) → "On My Way" (t≈76s) → pickup nav →
arrived (t≈148s) → Start ride (t≈153s) → drop-off leg → Complete (t≈394s) → home → history.
Findings below are cross-checked against `src/screens/driver/DriverActiveRideScreen.tsx`
and `src/screens/shared/RideHistoryScreen.tsx`.

## Confirmed bugs

### 1. Camera is never reset when leaving nav mode (root cause of two symptoms)
`onPress` on the Navigate/Exit-nav button (line ~1218) calls
`fitToCoordinates([location, target])` but never resets `pitch`/`heading`, so the tilted
3D nav camera is retained.
- **t=234.0** — on exiting nav the map lands on Valley Hospice / Cemetery with the driver
  marker off-screen for ~0.5 s before settling.
- **t=390–395 (worse)** — exiting nav ~20 m from the drop-off means `location` and `target`
  are nearly the same point, so `fitToCoordinates` zooms to maximum. Result: a blank cream
  polygon (one building footprint), no roads, no route, no drop-off marker, driver marker
  clipped behind the bottom sheet — and it stays that way through the Complete-ride tap.
  Same washed-out tiles at t=348 and t=360.
Fix direction: `animateCamera` with explicit `pitch: 0, heading: 0` and a minimum-span
floor before/instead of `fitToCoordinates`.

### 2. World-map flash on entering nav (t=80s)
First frame of the pickup nav view renders centred on the North Atlantic / Europe (default
camera) with the ETA showing "—", then flies to the real position over ~4 s; at t=84 the
map is a solid green fill mid-flight. Very visible on a demo.

### 3. Step advance is proximity-only, so a missed turn point strands the banner and then
###    forces a wrong-way reroute
`steps[currentStepIndex]` only advances when a GPS sample lands **within 50 m of that
step's end point** (line ~547). There is no "already passed it" projection, so if no sample
falls inside the radius the index sticks and the banner distance counts **up**.
Observed end-to-end:
- t=373→379: "Turn right onto Evangeline Trl" 33 m → 44 m → 57 m while approaching.
- Off-route detection (50 m / 3 s) eventually trips, `setCurrentStepIndex(0)` runs and a new
  route is fetched — t=382 flips to "Head east on Evangeline Trl 0.2 km" and the ETA jumps
  1 min → 2 min, i.e. the reroute points the driver away from the destination.
- Then oscillates 250 → 240 → 240 → 250 m.
Earlier in the same leg (t=186–222) the driver marker runs down Oakdene Ave while the drawn
route stays on Bridge St — far beyond the 50 m threshold. Note the "Rerouting…" banner is
gated on `navMode` (line ~1130), so during the overview view a reroute can fire with no
visible feedback at all.
Marker also sits visibly off the polyline at t=102, t=114, t=234.

### 4. ETA can never reach 0 / "Arriving"
`setEta(Math.max(1, Math.ceil(secs / 60)))` (lines 415 and 729) floors the ETA at 1 min. The
pickup card therefore reads "1 min" while the car is stopped **at** the pickup (t=148–152),
and the drop-off card reads "2 min" at the kerb through completion.
(The ETA being *coarse* is by design — the 2026-07-27 Maps cost fix moved to local
interpolation between ~7 route fetches. Only the missing 0/"Arriving" state is a defect.)

### 5. "On your left / on your right" flaps
Pickup: right (t=84–96) → left (t=102+). Drop-off: right (t=336) → left (t=342) → left
(t=348) → right (t=354). Recomputed every tick instead of being latched once within the
approach radius.

### 6. Ride history shows booking time, not completion time
`RideHistoryScreen.tsx:570` renders `formatTime(ride.created_at)`, and the list is ordered
by `created_at`. The ride completed at 8:43 PM and was scheduled for 8:45 PM but lists as
"8:36 PM". `rides.completed_at` has existed since migration 20260718 — use it (with a
fallback) for completed rows.

### 7. Nav still routes after arrival (t=151–152)
After "I've arrived at pickup" is tapped, nav stays up for ~2 s showing a freshly fetched
instruction — "Head east on James St toward Smith Ave, 59 m" — routing to a pickup already
reached. The `ride.status` effect refetches the route before the state settles.

## Minor / low confidence
- **Turn distance stalls**: "Head west on Mountain View St" holds at 100 m across t=84, 90,
  96 before dropping to 67 m. Only 3 samples at 6 s spacing, so this may just be the
  sampling interval — same root cause as #3 if real.
- **Drop-off marker position**: the flag sits near Webster St / Paddy's Brewpub at
  t=158–222 and near TACOcentric / Masters Ave at t=372+. Likely a zoomed-out edge-of-screen
  artifact and the later position is the correct geocode for 451 Main St — worth a one-off
  check against the ride's `dropoff_lat/lng` but not treated as a finding.

## Not bugs (checked and cleared)
- **"Nav mode exits on its own"** — `setNavMode` is written in exactly one place, the
  toggle's `onPress` (line 1209). The t=234 and t=390 exits were driver taps; the t=153 exit
  is the component re-initialising on the ride-status change. No auto-exit path exists.
- **History totals counting cancelled rides** — both the count and the total filter on
  `status === 'completed'` (lines ~215 and ~437–452). Correct as-is.

## Design question, not a bug
- **"Complete ride" is enabled from t=156**, the instant the ride starts, ~2 km and 3 min
  from the destination. There is no proximity gate. Deliberate or not is a product call.
