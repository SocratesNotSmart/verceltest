// A deliberately conservative reader for OSM `opening_hours` strings.
//
// It only answers "inactive" for patterns it fully understands. Anything with a
// month range, a nth-weekday selector, a public-holiday rule, a comment or any
// other syntax it does not recognise comes back as `unknown`, and the app then
// treats the zone as if it were active. Getting this wrong in the optimistic
// direction costs the driver a fine, so we never guess in that direction.

const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const TZ = 'Europe/Rome';

// Local wall-clock time in Italy, independent of the phone's own time zone.
export function italyNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = DAYS.indexOf(get('weekday').slice(0, 2).toLowerCase());
  let hour = parseInt(get('hour'), 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'), 10);
  return { weekday, minutes: hour * 60 + minute, label: `${get('hour')}:${get('minute')}` };
}

function parseDaySelector(text) {
  const days = new Set();
  for (const part of text.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token) continue;
    const range = token.match(/^([a-z]{2})-([a-z]{2})$/);
    if (range) {
      const from = DAYS.indexOf(range[1]);
      const to = DAYS.indexOf(range[2]);
      if (from < 0 || to < 0) return null;
      for (let i = 0; i < 7; i++) {
        const d = (from + i) % 7;
        days.add(d);
        if (d === to) break;
      }
      continue;
    }
    const single = DAYS.indexOf(token);
    if (single < 0) return null;
    days.add(single);
  }
  return days.size ? days : null;
}

function parseTimeRanges(text) {
  const ranges = [];
  for (const part of text.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const m = token.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    let end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (end === 0) end = 24 * 60;
    if (start > 24 * 60 || end > 24 * 60) return null;
    ranges.push([start, end]);
  }
  return ranges.length ? ranges : null;
}

function inRanges(minutes, ranges) {
  for (const [start, end] of ranges) {
    if (end > start) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) {
      return true; // range wraps past midnight
    }
  }
  return false;
}

/**
 * @returns {{state: 'active'|'inactive'|'unknown', reason?: string}}
 */
export function evaluateHours(value, now = italyNow()) {
  if (!value) return { state: 'unknown', reason: 'no-value' };
  const raw = String(value).trim();
  if (!raw) return { state: 'unknown', reason: 'no-value' };
  if (/24\/7/.test(raw)) return { state: 'active', reason: '24/7' };
  // Anything we cannot model: months, weeks, holidays, sunrise/sunset, comments.
  if (/[""]|\b(PH|SH|easter|sunrise|sunset|dawn|dusk)\b|\bweek\b|\[|\]/i.test(raw)) {
    return { state: 'unknown', reason: 'unsupported-syntax' };
  }
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(raw)) {
    return { state: 'unknown', reason: 'seasonal' };
  }

  let sawUsableRule = false;
  let active = false;

  for (const chunk of raw.split(';')) {
    const rule = chunk.trim();
    if (!rule) continue;

    const closing = /\b(off|closed)\b/i.test(rule);
    const body = rule.replace(/\b(off|closed)\b/gi, '').trim();

    // Split the leading weekday selector from the trailing time ranges.
    const match = body.match(/^([A-Za-z,\-\s]*?)\s*((?:\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}\s*,?\s*)*)$/);
    if (!match) return { state: 'unknown', reason: 'unparsed-rule' };

    const dayText = match[1].trim();
    const timeText = match[2].trim();

    let days = null;
    if (dayText) {
      days = parseDaySelector(dayText);
      if (!days) return { state: 'unknown', reason: 'unparsed-days' };
    }

    let ranges = null;
    if (timeText) {
      ranges = parseTimeRanges(timeText);
      if (!ranges) return { state: 'unknown', reason: 'unparsed-times' };
    }

    if (!days && !ranges && !closing) return { state: 'unknown', reason: 'empty-rule' };

    const dayMatches = !days || days.has(now.weekday);
    const timeMatches = !ranges || inRanges(now.minutes, ranges);

    sawUsableRule = true;
    if (dayMatches && timeMatches) active = !closing;
  }

  if (!sawUsableRule) return { state: 'unknown', reason: 'no-rules' };
  return { state: active ? 'active' : 'inactive' };
}
