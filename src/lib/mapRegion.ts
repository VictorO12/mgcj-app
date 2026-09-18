// How tight the map sits on the user when we recentre on them. Passenger and
// driver share it so the two surfaces can't drift apart: ~0.03 degrees is a
// little over 3 km of span, close enough to read street names but still wide
// enough to show nearby drivers/pickups without an extra pinch.
export const USER_REGION_DELTA = 0.03;

export function regionAroundUser(coords: {
  latitude: number;
  longitude: number;
}) {
  return {
    ...coords,
    latitudeDelta: USER_REGION_DELTA,
    longitudeDelta: USER_REGION_DELTA,
  };
}
