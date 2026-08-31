// Geometry helpers. All coordinates are [lat, lng] pairs in degrees.
// Distances are metres, computed with a local equirectangular projection which
// is accurate well below 0.1% for the few-kilometre ranges we care about.

const R = 6371008.8; // mean Earth radius, metres
const DEG = Math.PI / 180;

export function metresPerDegree(lat) {
  const latRad = lat * DEG;
  return {
    x: DEG * R * Math.cos(latRad), // metres per degree of longitude
    y: DEG * R,                    // metres per degree of latitude
  };
}

export function haversine(a, b) {
  const dLat = (b[0] - a[0]) * DEG;
  const dLng = (b[1] - a[1]) * DEG;
  const lat1 = a[0] * DEG;
  const lat2 = b[0] * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Move a point `dist` metres along `bearing` (degrees, 0 = north, clockwise).
export function project(point, bearing, dist) {
  const m = metresPerDegree(point[0]);
  const rad = bearing * DEG;
  return [
    point[0] + (dist * Math.cos(rad)) / m.y,
    point[1] + (dist * Math.sin(rad)) / m.x,
  ];
}

export function bboxOfRing(ring) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return [minLat, minLng, maxLat, maxLng];
}

export function unionBbox(boxes) {
  let out = null;
  for (const b of boxes) {
    if (!b) continue;
    if (!out) { out = b.slice(); continue; }
    out[0] = Math.min(out[0], b[0]);
    out[1] = Math.min(out[1], b[1]);
    out[2] = Math.max(out[2], b[2]);
    out[3] = Math.max(out[3], b[3]);
  }
  return out;
}

export function bboxContains(box, point, padDeg = 0) {
  return point[0] >= box[0] - padDeg && point[0] <= box[2] + padDeg &&
         point[1] >= box[1] - padDeg && point[1] <= box[3] + padDeg;
}

export function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

// Ray casting. Ring is a closed or open list of [lat, lng].
export function pointInRing(point, ring) {
  const [y, x] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    const intersects = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Perpendicular distance in metres from a point to the segment a-b.
function distToSegment(point, a, b, m) {
  const px = point[1] * m.x, py = point[0] * m.y;
  const ax = a[1] * m.x, ay = a[0] * m.y;
  const bx = b[1] * m.x, by = b[0] * m.y;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

export function distToRing(point, ring) {
  const m = metresPerDegree(point[0]);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distToSegment(point, ring[j], ring[i], m);
    if (d < best) best = d;
  }
  return best;
}

// A zone is { outers: [ring], inners: [ring], bbox }.
export function pointInZone(point, zone) {
  if (!bboxContains(zone.bbox, point)) return false;
  let inOuter = false;
  for (const ring of zone.outers) {
    if (pointInRing(point, ring)) { inOuter = true; break; }
  }
  if (!inOuter) return false;
  for (const ring of zone.inners) {
    if (pointInRing(point, ring)) return false; // inside a hole
  }
  return true;
}

// Signed-ish distance: 0 when inside, otherwise metres to the nearest edge.
export function distanceToZone(point, zone) {
  if (pointInZone(point, zone)) return 0;
  let best = Infinity;
  // Inner rings count too: standing in a courtyard cut out of a zone, the nearest
  // boundary is the hole's edge, not the far-away outer edge.
  for (const ring of [...zone.outers, ...zone.inners]) {
    const d = distToRing(point, ring);
    if (d < best) best = d;
  }
  return best;
}

// Cheap pre-filter: metres from the point to the zone bounding box (0 if within).
export function distanceToBbox(point, box) {
  const m = metresPerDegree(point[0]);
  const dLat = Math.max(box[0] - point[0], 0, point[0] - box[2]) * m.y;
  const dLng = Math.max(box[1] - point[1], 0, point[1] - box[3]) * m.x;
  return Math.hypot(dLat, dLng);
}

export function formatDistance(metres) {
  if (!isFinite(metres)) return '–';
  if (metres < 1000) return `${Math.round(metres / 5) * 5} m`;
  if (metres < 10000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 1000)} km`;
}

export function ringArea(ring) {
  // Shoelace on the local projection, in square metres. Used only for sanity checks.
  if (ring.length < 3) return 0;
  const m = metresPerDegree(ring[0][0]);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][1] * m.x) * (ring[i][0] * m.y) - (ring[i][1] * m.x) * (ring[j][0] * m.y);
  }
  return Math.abs(sum / 2);
}

// Bearing in degrees (0 = north, clockwise) from a to b.
export function bearingBetween(a, b) {
  const m = metresPerDegree((a[0] + b[0]) / 2);
  const dx = (b[1] - a[1]) * m.x;
  const dy = (b[0] - a[0]) * m.y;
  if (dx === 0 && dy === 0) return null;
  return (Math.atan2(dx, dy) / DEG + 360) % 360;
}
