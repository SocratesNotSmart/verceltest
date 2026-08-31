import {
  distanceToZone, distanceToBbox, pointInZone, project, bearingBetween,
  formatDistance, haversine, bboxIntersects,
} from './geo.js';
import { evaluateHours, italyNow } from './hours.js';
import { fetchZones } from './overpass.js';
import { saveZones, loadZones, saveCoverage, loadCoverage, isCovered, clearAll } from './store.js';
import { t, setLang, getLang, LANGS } from './i18n.js';
import { unlockAudio, beep, vibrate, speak, requestWakeLock, releaseWakeLock } from './alerts.js';

const ITALY_BBOX = [35.2, 6.4, 47.3, 18.8];
const CANDIDATE_RADIUS = 6000;   // metres; zones further away are ignored per tick
const REALERT_INSIDE_MS = 60000; // nag again while still inside
const AUTO_DOWNLOAD_SPAN = 0.22; // degrees of padding around the driver

const DEFAULTS = {
  lang: (navigator.language || 'lt').slice(0, 2),
  sound: true,
  voice: true,
  vibrate: true,
  keepAwake: true,
  warnRadius: 300,
  lookahead: 12,
  autoDownload: true,
};

const state = {
  zones: [],
  coverage: [],
  position: null,
  prevPoint: null,
  heading: null,
  speed: 0,
  status: 'idle',
  inside: [],
  nearest: null,
  tracking: false,
  follow: true,
  simulate: false,
  lastAlert: { status: null, at: 0 },
  programmaticMove: false,
  candidates: [],
  autoDownloadInFlight: false,
  lastAutoDownloadAt: 0,
  settings: loadSettings(),
};

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('ztl-settings') || '{}');
  } catch { /* ignore corrupt settings */ }
  const merged = { ...DEFAULTS, ...stored };
  if (!LANGS.includes(merged.lang)) merged.lang = 'lt';
  return merged;
}

function persistSettings() {
  try {
    localStorage.setItem('ztl-settings', JSON.stringify(state.settings));
  } catch { /* private mode; not fatal */ }
}

const $ = (sel) => document.querySelector(sel);
const el = {
  banner: $('#banner'),
  bannerTitle: $('#banner-title'),
  bannerDetail: $('#banner-detail'),
  stats: $('#stats'),
  toggle: $('#toggle'),
  recenter: $('#recenter'),
  settingsBtn: $('#settings-btn'),
  sheet: $('#sheet'),
  sheetBody: $('#sheet-body'),
  sheetTitle: $('#sheet-title'),
  toast: $('#toast'),
  zoneList: $('#zone-list'),
  status: $('#data-status'),
};

/* ---------------------------------------------------------------- map --- */

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false, // shown in the dock, where the panels can't cover it
  preferCanvas: true,
}).setView([43.77, 11.25], 13);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

L.control.zoom({ position: 'topright' }).addTo(map);

const zoneLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);
let accuracyCircle = null;
let meMarker = null;
let lookaheadLine = null;
const renderedZones = new Map();

map.on('movestart', () => {
  if (state.programmaticMove) return; // our own recentre, not the user panning
  if (state.tracking) state.follow = false;
  el.recenter.classList.remove('hidden');
});
map.on('moveend', () => {
  state.programmaticMove = false;
  renderZones();
});

map.on('click', (ev) => {
  if (!state.simulate) return;
  applyPosition({
    lat: ev.latlng.lat,
    lng: ev.latlng.lng,
    accuracy: 5,
    heading: state.heading,
    speed: state.speed || 8,
    simulated: true,
  });
});

/* -------------------------------------------------------------- zones --- */

function zoneStatus(zone) {
  const hours = evaluateHours(zone.hours, italyNow());
  return hours.state; // active | inactive | unknown
}

function zoneStyle(zone, isInside) {
  const status = zoneStatus(zone);
  const lez = zone.kind === 'lez';
  if (isInside) {
    return { color: '#ff2d2d', weight: 3, fillColor: '#ff2d2d', fillOpacity: 0.42, dashArray: null };
  }
  if (status === 'inactive') {
    return { color: '#7a8899', weight: 2, fillColor: '#7a8899', fillOpacity: 0.12, dashArray: '6 5' };
  }
  return lez
    ? { color: '#a855f7', weight: 2, fillColor: '#a855f7', fillOpacity: 0.2, dashArray: null }
    : { color: '#ff7043', weight: 2, fillColor: '#ff7043', fillOpacity: 0.25, dashArray: null };
}

function zoneToLatLngs(zone) {
  return [...zone.outers.map((r) => r), ...zone.inners.map((r) => r)];
}

function renderZones() {
  const bounds = map.getBounds();
  const viewBbox = [
    bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast(),
  ];
  const visible = new Set();

  for (const zone of state.zones) {
    if (!bboxIntersects(zone.bbox, viewBbox)) continue;
    visible.add(zone.id);
    const isInside = state.inside.some((z) => z.id === zone.id);
    let poly = renderedZones.get(zone.id);
    if (!poly) {
      poly = L.polygon(zoneToLatLngs(zone), zoneStyle(zone, isInside));
      poly.on('click', () => showZoneDetails(zone));
      renderedZones.set(zone.id, poly);
      zoneLayer.addLayer(poly);
    } else {
      poly.setStyle(zoneStyle(zone, isInside));
      if (!zoneLayer.hasLayer(poly)) zoneLayer.addLayer(poly);
    }
  }

  for (const [id, poly] of renderedZones) {
    if (!visible.has(id) && zoneLayer.hasLayer(poly)) zoneLayer.removeLayer(poly);
  }
}

function updateDataStatus() {
  const offline = !navigator.onLine ? ` · ${escapeHtml(t('offline'))}` : '';
  el.status.innerHTML = `${escapeHtml(t('zonesLoaded'))}: ${state.zones.length}${offline}` +
    ` · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap</a>`;
}

async function ingestZones(zones, bbox) {
  const byId = new Map(state.zones.map((z) => [z.id, z]));
  for (const zone of zones) byId.set(zone.id, zone);
  state.zones = [...byId.values()];
  await saveZones(zones);
  if (bbox) {
    const entry = await saveCoverage(bbox);
    state.coverage.push(entry);
  }
  renderZones();
  updateDataStatus();
  evaluate();
}

async function downloadArea(bbox, label) {
  toast(t('downloading'));
  el.sheetBody?.classList.add('busy');
  try {
    const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]);
    const zones = await fetchZones(bbox, { timeout: span > 3 ? 240 : 90 });
    await ingestZones(zones, bbox);
    toast(t('downloaded', zones.length) + (label ? ` – ${label}` : ''));
    return zones.length;
  } catch (err) {
    console.error(err);
    toast(`${t('downloadFail')}: ${err.message || err}`, 5000);
    return null;
  } finally {
    el.sheetBody?.classList.remove('busy');
  }
}

function maybeAutoDownload(point) {
  if (!state.settings.autoDownload || !navigator.onLine) return;
  if (state.autoDownloadInFlight) return;
  if (Date.now() - state.lastAutoDownloadAt < 20000) return;
  if (isCovered(state.coverage, point)) return;
  state.autoDownloadInFlight = true;
  state.lastAutoDownloadAt = Date.now();
  const bbox = [
    point[0] - AUTO_DOWNLOAD_SPAN, point[1] - AUTO_DOWNLOAD_SPAN,
    point[0] + AUTO_DOWNLOAD_SPAN, point[1] + AUTO_DOWNLOAD_SPAN,
  ];
  downloadArea(bbox).finally(() => { state.autoDownloadInFlight = false; });
}

/* ----------------------------------------------------------- position --- */

function applyPosition({ lat, lng, accuracy, heading, speed, simulated }) {
  const point = [lat, lng];
  if (state.position) {
    const prev = [state.position.lat, state.position.lng];
    if (haversine(prev, point) > 5) {
      const bearing = bearingBetween(prev, point);
      if (bearing !== null) state.heading = bearing;
      state.prevPoint = prev;
    }
  }
  if (typeof heading === 'number' && !Number.isNaN(heading)) state.heading = heading;
  state.speed = typeof speed === 'number' && speed >= 0 ? speed : state.speed;
  state.position = { lat, lng, accuracy: accuracy ?? 0, ts: Date.now(), simulated };

  drawMe();
  if (state.follow) {
    state.programmaticMove = true;
    map.setView(point, Math.max(map.getZoom(), 14), { animate: true });
  }
  maybeAutoDownload(point);
  evaluate();
}

function drawMe() {
  if (!state.position) return;
  const point = [state.position.lat, state.position.lng];
  if (!meMarker) {
    meMarker = L.marker(point, {
      icon: L.divIcon({
        className: 'me-icon',
        html: '<div class="me-dot"><span class="me-arrow"></span></div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(meLayer);
    accuracyCircle = L.circle(point, {
      radius: state.position.accuracy,
      color: '#2f81f7', weight: 1, fillColor: '#2f81f7', fillOpacity: 0.12, interactive: false,
    }).addTo(meLayer);
  } else {
    meMarker.setLatLng(point);
    accuracyCircle.setLatLng(point);
    accuracyCircle.setRadius(state.position.accuracy);
  }
  const arrow = meMarker.getElement()?.querySelector('.me-arrow');
  if (arrow) {
    arrow.style.opacity = state.heading === null ? '0' : '1';
    arrow.style.transform = `rotate(${state.heading ?? 0}deg)`;
  }

  const ahead = lookaheadPoint();
  if (ahead) {
    if (!lookaheadLine) {
      lookaheadLine = L.polyline([point, ahead], {
        color: '#2f81f7', weight: 3, opacity: 0.6, dashArray: '6 6', interactive: false,
      }).addTo(meLayer);
    } else {
      lookaheadLine.setLatLngs([point, ahead]);
    }
  } else if (lookaheadLine) {
    meLayer.removeLayer(lookaheadLine);
    lookaheadLine = null;
  }
}

// Points along the predicted path, so a zone we would cut straight through
// still triggers instead of only one we would stop inside.
function lookaheadSamples() {
  const ahead = lookaheadPoint();
  if (!ahead || !state.position) return [];
  const here = [state.position.lat, state.position.lng];
  const total = haversine(here, ahead);
  const steps = Math.min(24, Math.max(2, Math.round(total / 50)));
  const samples = [];
  for (let i = 1; i <= steps; i++) {
    samples.push([
      here[0] + ((ahead[0] - here[0]) * i) / steps,
      here[1] + ((ahead[1] - here[1]) * i) / steps,
    ]);
  }
  return samples;
}

function lookaheadPoint() {
  if (!state.position || state.heading === null) return null;
  const seconds = state.settings.lookahead;
  if (!seconds) return null;
  const dist = Math.max(state.speed, 0) * seconds;
  if (dist < 25) return null;
  return project([state.position.lat, state.position.lng], state.heading, Math.min(dist, 1500));
}

/* --------------------------------------------------------- evaluation --- */

function evaluate() {
  if (!state.tracking && !state.position) {
    setStatus('idle');
    return;
  }
  if (!state.position) {
    setStatus('nofix');
    return;
  }

  const point = [state.position.lat, state.position.lng];
  const ahead = lookaheadSamples();
  const accuracy = Math.min(state.position.accuracy || 0, 150);

  const candidates = [];
  for (const zone of state.zones) {
    if (distanceToBbox(point, zone.bbox) > CANDIDATE_RADIUS) continue;
    const dist = distanceToZone(point, zone);
    const aheadInside = ahead.some((p) => pointInZone(p, zone));
    candidates.push({ zone, dist, aheadInside });
  }
  candidates.sort((a, b) => a.dist - b.dist);

  state.inside = candidates.filter((c) => c.dist === 0).map((c) => c.zone);
  state.nearest = candidates[0] || null;
  state.candidates = candidates;

  let status;
  if (state.inside.length) {
    status = 'inside';
  } else if (
    candidates.some((c) => c.aheadInside) ||
    (state.nearest && state.nearest.dist - accuracy <= state.settings.warnRadius)
  ) {
    status = 'approaching';
  } else {
    status = 'clear';
  }
  setStatus(status);
  renderZones();
  renderStats();
  renderZoneList();
}

function setStatus(status) {
  const changed = state.status !== status;
  state.status = status;
  document.body.dataset.status = status;

  const titles = {
    idle: t('idle'), nofix: t('noFix'), clear: t('clear'),
    approaching: t('approaching'), inside: t('inside'),
  };
  el.bannerTitle.textContent = titles[status];

  let detail = '';
  if (status === 'inside') {
    const zone = state.inside[0];
    const hours = zoneStatus(zone);
    detail = `${zone.name} · ${hoursLabel(hours)}`;
    if (state.inside.length > 1) detail += ` (+${state.inside.length - 1})`;
  } else if (state.nearest) {
    detail = `${state.nearest.zone.name} · ${formatDistance(state.nearest.dist)}`;
  } else if (status === 'clear') {
    detail = t('noZonesNearby');
  }
  el.bannerDetail.textContent = detail;

  const now = Date.now();
  const shouldAlert = (status === 'inside' || status === 'approaching') &&
    (changed || (status === 'inside' && now - state.lastAlert.at > REALERT_INSIDE_MS));
  if (shouldAlert && state.tracking) {
    state.lastAlert = { status, at: now };
    if (state.settings.sound) beep(status);
    if (state.settings.vibrate) vibrate(status);
    if (state.settings.voice) speak(status);
  }
  if (changed && status === 'clear') state.lastAlert = { status, at: 0 };
}

function hoursLabel(status) {
  if (status === 'active') return t('hoursActive');
  if (status === 'inactive') return t('hoursInactive');
  return t('hoursUnknown');
}

function renderStats() {
  if (!state.position) { el.stats.innerHTML = ''; return; }
  const kmh = Math.round((state.speed || 0) * 3.6);
  const cells = [
    [t('distance'), state.nearest ? formatDistance(state.nearest.dist) : '–'],
    [t('speed'), `${kmh} km/h`],
    [t('accuracy'), `±${Math.round(state.position.accuracy)} m`],
  ];
  el.stats.innerHTML = cells
    .map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');
}

function renderZoneList() {
  const list = (state.candidates || []).slice(0, 6);
  if (!list.length) {
    el.zoneList.innerHTML = `<li class="empty">${t('noZonesNearby')}</li>`;
    return;
  }
  el.zoneList.innerHTML = list.map(({ zone, dist }) => {
    const status = zoneStatus(zone);
    return `<li data-zone="${zone.id}" class="zone-row ${status}">
      <span class="dot"></span>
      <span class="name">${escapeHtml(zone.name)}</span>
      <span class="dist">${dist === 0 ? '⚠︎' : formatDistance(dist)}</span>
    </li>`;
  }).join('');
}

el.zoneList.addEventListener('click', (ev) => {
  const row = ev.target.closest('[data-zone]');
  if (!row) return;
  const zone = state.zones.find((z) => z.id === row.dataset.zone);
  if (zone) showZoneDetails(zone);
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ------------------------------------------------------------ tracking --- */

let watchId = null;

function startTracking() {
  unlockAudio();
  if (!navigator.geolocation) { toast(t('geoUnsupported'), 6000); return; }
  state.tracking = true;
  state.follow = true;
  document.body.dataset.tracking = 'on';
  el.toggle.textContent = t('stop');
  setStatus('nofix');
  if (state.settings.keepAwake) requestWakeLock();

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (state.simulate) return;
      applyPosition({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
      });
    },
    (err) => {
      console.warn(err);
      toast(err.code === err.PERMISSION_DENIED ? t('permissionDenied') : err.message, 6000);
      if (err.code === err.PERMISSION_DENIED) stopTracking();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

function stopTracking() {
  state.tracking = false;
  document.body.dataset.tracking = 'off';
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  releaseWakeLock();
  el.toggle.textContent = t('start');
  setStatus('idle');
}

el.toggle.addEventListener('click', () => {
  if (state.tracking) stopTracking(); else startTracking();
});

el.recenter.addEventListener('click', () => {
  state.follow = true;
  if (state.position) {
    state.programmaticMove = true;
    map.setView([state.position.lat, state.position.lng], Math.max(map.getZoom(), 15));
  }
  el.recenter.classList.add('hidden');
});

/* ---------------------------------------------------------------- ui ---- */

let toastTimer = null;
function toast(message, ms = 3000) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function openSheet(title, html) {
  el.sheetTitle.textContent = title;
  el.sheetBody.innerHTML = html;
  el.sheet.classList.add('open');
}

function closeSheet() {
  el.sheet.classList.remove('open');
}

$('#sheet-close').addEventListener('click', closeSheet);

function showZoneDetails(zone) {
  const status = zoneStatus(zone);
  const interesting = ['opening_hours', 'motor_vehicle', 'motor_vehicle:conditional', 'vehicle',
    'access', 'operator', 'ref', 'website', 'description', 'note'];
  const rows = interesting
    .filter((k) => zone.tags[k])
    .map((k) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(zone.tags[k])}</td></tr>`)
    .join('');
  openSheet(zone.name, `
    <p class="kind">${zone.kind === 'lez' ? t('kindLez') : t('kindZtl')}</p>
    <p class="hours-state ${status}">${hoursLabel(status)}</p>
    ${zone.hours ? `<p class="hours"><strong>${t('hoursLabel')}:</strong> <code>${escapeHtml(zone.hours)}</code></p>` : ''}
    ${rows ? `<table class="tags">${rows}</table>` : ''}
    <p><a target="_blank" rel="noopener"
      href="https://www.openstreetmap.org/${zone.osmType}/${zone.osmId}">${t('openOsm')}</a></p>
    <p class="disclaimer">${t('disclaimer')}</p>
  `);
}

async function geocodeAndDownload(query) {
  if (!query.trim()) return;
  toast(t('searching'));
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const hits = await res.json();
    if (!hits.length) { toast(t('searchFail'), 4000); return; }
    const hit = hits[0];
    // Nominatim boundingbox is [south, north, west, east].
    const [south, north, west, east] = hit.boundingbox.map(Number);
    const pad = 0.05;
    const bbox = [south - pad, west - pad, north + pad, east + pad];
    state.follow = false;
    state.programmaticMove = true;
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]]);
    await downloadArea(bbox, hit.name || query);
  } catch (err) {
    toast(`${t('searchFail')}: ${err.message || err}`, 4000);
  }
}

function settingRow(label, control) {
  return `<label class="setting"><span>${label}</span>${control}</label>`;
}

function showSettings() {
  const s = state.settings;
  openSheet(t('settings'), `
    ${settingRow(t('language'), `<select data-set="lang">${
      LANGS.map((l) => `<option value="${l}" ${s.lang === l ? 'selected' : ''}>${
        { lt: 'Lietuvių', en: 'English', it: 'Italiano' }[l]}</option>`).join('')
    }</select>`)}
    ${settingRow(t('warnRadius'), `<select data-set="warnRadius">${
      [150, 300, 500, 800, 1200].map((v) => `<option value="${v}" ${s.warnRadius === v ? 'selected' : ''}>${v} m</option>`).join('')
    }</select>`)}
    ${settingRow(t('lookahead'), `<select data-set="lookahead">${
      [0, 8, 12, 20, 30].map((v) => `<option value="${v}" ${s.lookahead === v ? 'selected' : ''}>${v ? `${v} ${t('seconds')}` : '–'}</option>`).join('')
    }</select>`)}
    ${settingRow(t('sound'), `<input type="checkbox" data-set="sound" ${s.sound ? 'checked' : ''}>`)}
    ${settingRow(t('voice'), `<input type="checkbox" data-set="voice" ${s.voice ? 'checked' : ''}>`)}
    ${settingRow(t('vibrate'), `<input type="checkbox" data-set="vibrate" ${s.vibrate ? 'checked' : ''}>`)}
    ${settingRow(t('keepAwake'), `<input type="checkbox" data-set="keepAwake" ${s.keepAwake ? 'checked' : ''}>`)}
    ${settingRow(t('autoDownload'), `<input type="checkbox" data-set="autoDownload" ${s.autoDownload ? 'checked' : ''}>`)}
    ${settingRow(t('simulate'), `<input type="checkbox" data-sim ${state.simulate ? 'checked' : ''}>`)}
    <div class="search">
      <label for="city-search">${t('searchLabel')}</label>
      <div class="search-row">
        <input id="city-search" type="search" enterkeyhint="search"
               placeholder="${t('searchPlaceholder')}" autocomplete="off">
        <button data-action="search">${t('searchGo')}</button>
      </div>
    </div>
    <div class="actions">
      <button data-action="download-view">${t('download')}</button>
      <button data-action="download-italy">🇮🇹 Italia</button>
      <button data-action="clear" class="danger">${t('clearData')}</button>
    </div>
    <p class="disclaimer">${t('disclaimer')}</p>
    <p class="disclaimer">${t('installHint')}</p>
  `);
}

el.settingsBtn.addEventListener('click', showSettings);

el.sheetBody.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.id === 'city-search') {
    ev.preventDefault();
    geocodeAndDownload(ev.target.value);
  }
});

el.sheetBody.addEventListener('change', (ev) => {
  const target = ev.target;
  if (target.dataset.sim !== undefined) {
    state.simulate = target.checked;
    document.body.dataset.sim = state.simulate ? 'on' : 'off';
    if (state.simulate) toast(t('simulate'), 4000);
    return;
  }
  const key = target.dataset.set;
  if (!key) return;
  const value = target.type === 'checkbox' ? target.checked
    : (['warnRadius', 'lookahead'].includes(key) ? Number(target.value) : target.value);
  state.settings[key] = value;
  persistSettings();
  if (key === 'lang') { setLang(value); applyStaticText(); showSettings(); }
  if (key === 'keepAwake') { value ? requestWakeLock() : releaseWakeLock(); }
  evaluate();
});

el.sheetBody.addEventListener('click', async (ev) => {
  const action = ev.target.dataset.action;
  if (!action) return;
  if (action === 'search') {
    await geocodeAndDownload($('#city-search')?.value || '');
  } else if (action === 'download-view') {
    const b = map.getBounds();
    await downloadArea([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
  } else if (action === 'download-italy') {
    await downloadArea(ITALY_BBOX, 'Italia');
  } else if (action === 'clear') {
    await clearAll();
    state.zones = [];
    state.coverage = [];
    for (const poly of renderedZones.values()) zoneLayer.removeLayer(poly);
    renderedZones.clear();
    updateDataStatus();
    evaluate();
    toast(t('dataCleared'));
  }
});

function applyStaticText() {
  document.documentElement.lang = getLang();
  const appName = $('#app-name');
  if (appName) appName.textContent = t('appName');
  el.toggle.textContent = state.tracking ? t('stop') : t('start');
  el.recenter.title = t('recenter');
  el.settingsBtn.title = t('settings');
  const nearby = $('#nearby-title');
  if (nearby) nearby.textContent = t('nearbyZones');
  setStatus(state.status);
  renderStats();
  renderZoneList();
  updateDataStatus();
}

window.addEventListener('online', updateDataStatus);
window.addEventListener('offline', updateDataStatus);

/* -------------------------------------------------------------- boot ---- */

async function boot() {
  setLang(state.settings.lang);
  try {
    applyStaticText();
  } catch (err) {
    console.error('static text', err);
  }
  document.body.dataset.tracking = 'off';

  try {
    const [zones, coverage] = await Promise.all([loadZones(), loadCoverage()]);
    state.zones = zones;
    state.coverage = coverage;
  } catch (err) {
    console.warn('storage unavailable', err);
  }
  renderZones();
  updateDataStatus();
  renderZoneList();

  // Centre on the last known map view so a reload does not jump to Florence.
  try {
    const last = JSON.parse(localStorage.getItem('ztl-view') || 'null');
    if (last) map.setView([last.lat, last.lng], last.zoom);
  } catch { /* ignore */ }
  map.on('moveend', () => {
    const c = map.getCenter();
    try {
      localStorage.setItem('ztl-view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
    } catch { /* ignore */ }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('sw', err));
  }
}

boot();

// Exposed for quick console checks while developing.
window.__ztl = { state, map, evaluate, applyPosition, downloadArea };
