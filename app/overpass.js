// Fetching ZTL / LEZ areas from OpenStreetMap through the Overpass API.
//
// Italian limited traffic zones are mapped as `boundary=limited_traffic_zone`
// (the approved scheme) and low emission zones as `boundary=low_emission_zone`.
// Plenty of older imports still only carry a `ZTL ...` name on a closed way or
// multipolygon, so we ask for those too and keep whatever forms a valid ring.

import { bboxOfRing, unionBbox, ringArea } from './geo.js';

export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const NAME_RE = 'ZTL|Zona a [Tt]raffico [Ll]imitato|Zona [Tt]raffico [Ll]imitato|Area [BC]';

export function buildQuery(bbox, timeout = 90) {
  const b = bbox.map((n) => n.toFixed(5)).join(',');
  return `[out:json][timeout:${timeout}];
(
  way["boundary"="limited_traffic_zone"](${b});
  relation["boundary"="limited_traffic_zone"](${b});
  way["boundary"="low_emission_zone"](${b});
  relation["boundary"="low_emission_zone"](${b});
  way["name"~"${NAME_RE}"]["highway"!~"."]["barrier"!~"."](${b});
  relation["name"~"${NAME_RE}"]["type"~"multipolygon|boundary"](${b});
);
out geom;`;
}

function toLatLng(geometry) {
  const ring = [];
  for (const p of geometry || []) {
    if (typeof p.lat === 'number' && typeof p.lon === 'number') ring.push([p.lat, p.lon]);
  }
  return ring;
}

function closeRing(ring) {
  if (ring.length < 4) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring.slice(0, -1);
  return null;
}

const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

// Stitch member ways into closed rings; open leftovers are dropped.
function assembleRings(segments) {
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const rings = [];
  while (pool.length) {
    let current = pool.shift();
    let progressed = true;
    while (progressed && key(current[0]) !== key(current[current.length - 1])) {
      progressed = false;
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        const tail = key(current[current.length - 1]);
        if (key(candidate[0]) === tail) {
          current = current.concat(candidate.slice(1));
        } else if (key(candidate[candidate.length - 1]) === tail) {
          current = current.concat(candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        pool.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (key(current[0]) === key(current[current.length - 1]) && current.length >= 4) {
      rings.push(current.slice(0, -1));
    }
  }
  return rings;
}

function classify(tags = {}) {
  if (tags.boundary === 'low_emission_zone') return 'lez';
  if (tags.boundary === 'limited_traffic_zone') return 'ztl';
  return 'ztl';
}

export function normaliseElement(el) {
  const tags = el.tags || {};
  let outers = [];
  let inners = [];

  if (el.type === 'way') {
    const ring = closeRing(toLatLng(el.geometry));
    if (!ring) return null;
    outers = [ring];
  } else if (el.type === 'relation') {
    const outerSegments = [];
    const innerSegments = [];
    for (const member of el.members || []) {
      if (member.type !== 'way' || !member.geometry) continue;
      const line = toLatLng(member.geometry);
      if (line.length < 2) continue;
      if (member.role === 'inner') innerSegments.push(line);
      else outerSegments.push(line); // "outer" and untagged members alike
    }
    outers = assembleRings(outerSegments);
    inners = assembleRings(innerSegments);
  } else {
    return null;
  }

  if (!outers.length) return null;
  // Guard against degenerate geometry (a stray micro-polygon would produce
  // nonsense warnings). 500 m2 is far below any real zone.
  outers = outers.filter((r) => ringArea(r) > 500);
  if (!outers.length) return null;

  const bbox = unionBbox(outers.map(bboxOfRing));
  return {
    id: `${el.type[0]}${el.id}`,
    osmType: el.type,
    osmId: el.id,
    name: tags.name || tags.ref || (classify(tags) === 'lez' ? 'Low emission zone' : 'ZTL'),
    kind: classify(tags),
    hours: tags.opening_hours || tags['motor_vehicle:conditional'] || '',
    tags,
    outers,
    inners,
    bbox,
    fetchedAt: Date.now(),
  };
}

export function parseResponse(json) {
  const zones = [];
  const seen = new Set();
  for (const el of json.elements || []) {
    const zone = normaliseElement(el);
    if (!zone || seen.has(zone.id)) continue;
    seen.add(zone.id);
    zones.push(zone);
  }
  return zones;
}

export async function fetchZones(bbox, { signal, onAttempt, timeout = 90 } = {}) {
  const body = buildQuery(bbox, timeout);
  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    try {
      onAttempt?.(endpoint);
      const res = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: body }),
        signal,
      });
      if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
      const json = await res.json();
      return parseResponse(json);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('Overpass unreachable');
}
