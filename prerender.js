/**
 * Walkout Watch — pre-render fight data
 *
 * Fetches published Google Sheets CSV and writes static files that
 * search engines and AI crawlers can read without running JavaScript.
 *
 * Key detail: Google's /pub?output=csv returns a 307 redirect to
 * googleusercontent.com. Node's https.get does NOT follow redirects,
 * so we follow them manually. That was the original bug.
 */

const https = require('https');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const SHEETS = {
  MMA: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQO5KHJO9BZh-9tHA_WBOgWc_Z9yNOG7fTf71pIoKVAyTbJ5hcxZFDWLBiGmU2veqdAvI7XvtbmhtIv/pub?output=csv',
  BOXING: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSKhzl-_Cl1B2o7uvLvacojSfJjwJ--v1GjLnWmA9tMPYTGo33-zkn4jEkumRoYPxxRvuLLe6PXO-RX/pub?output=csv',
};

const SITE = 'https://walkoutwatch.com';

/* ── Fetch with redirect following ── */
function fetchCSV(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft < 0) return reject(new Error('Too many redirects'));

    https.get(url, { headers: { 'User-Agent': 'walkoutwatch-prerender/1.0' } }, (res) => {
      // THE FIX: Google 307-redirects to googleusercontent.com.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain socket
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchCSV(next, redirectsLeft - 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/* ── Guard: make sure we got CSV, not an HTML error page ── */
function assertLooksLikeCSV(text, label) {
  const head = text.slice(0, 200).trim().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<body')) {
    throw new Error(
      `${label}: got HTML instead of CSV. The sheet is probably not published ` +
      `(File > Share > Publish to web > CSV), or the URL is wrong.`
    );
  }
  if (!text.trim()) throw new Error(`${label}: empty response`);
}

/* ── Date parsing: handles the formats Sheets actually emits ── */
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const d = String(dateStr).trim();
  const t = String(timeStr || '').trim();

  let y, m, day;

  let match = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);            // 2026-09-12
  if (match) { y = match[1]; m = match[2]; day = match[3]; }

  if (!y) {
    match = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);             // 9/12/2026
    if (match) { m = match[1]; day = match[2]; y = match[3]; }
  }

  if (!y) {                                                         // "Sep 12, 2026"
    const parsed = new Date(d + (t ? ' ' + t : ''));
    return isNaN(parsed) ? null : parsed.toISOString();
  }

  let hour = 0, min = 0;
  const tm = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (tm) {
    hour = parseInt(tm[1], 10);
    min = parseInt(tm[2], 10);
    const mer = (tm[3] || '').toUpperCase();
    if (mer === 'PM' && hour !== 12) hour += 12;
    if (mer === 'AM' && hour === 12) hour = 0;
  }

  const iso = new Date(Date.UTC(+y, +m - 1, +day, hour, min));
  return isNaN(iso) ? null : iso.toISOString();
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ── Map columns by HEADER NAME, not fixed position.
      This is why boxing (17 cols) and UFC (19 cols, has SUB) both work. ── */
function buildColumnMap(header) {
  const idx = {};
  header.forEach((h, i) => {
    const key = String(h || '').trim().toLowerCase();
    if (key) idx[key] = i;
  });
  const find = (...names) => {
    for (const n of names) if (idx[n] !== undefined) return idx[n];
    return -1;
  };
  return {
    eventId:    find('event id'),
    eventName:  find('event name'),
    org:        find('organization'),
    date:       find('date'),
    mainTime:   find('main time'),
    prelimTime: find('prelim time'),
    timezone:   find('timezone'),
    city:       find('city'),
    country:    find('country'),
    boutType:   find('bout type'),
    aName:      find('fighter a name'),
    aRecord:    find('fighter a record'),
    bName:      find('fighter b name'),
    bRecord:    find('fighter b record'),
    weight:     find('weight class'),
  };
}

function rowsToEvents(rows, sport) {
  if (!rows.length) return [];
  const map = buildColumnMap(rows[0]);
  const body = rows.slice(1);

  if (map.eventId < 0 || map.aName < 0) {
    throw new Error(`${sport}: could not find expected columns in the header row.`);
  }

  const grouped = new Map();

  for (const row of body) {
    const get = (i) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '');
    const eventId = get(map.eventId);
    const aName = get(map.aName);
    if (!eventId || !aName) continue;

    const datetime = parseDateTime(get(map.date), get(map.mainTime));
    if (!datetime) continue;

    if (!grouped.has(eventId)) {
      grouped.set(eventId, {
        id: `${sport.toLowerCase()}-${slugify(get(map.eventName) || eventId)}`,
        eventName: get(map.eventName),
        organization: get(map.org),
        sport,
        datetime,
        prelimDatetime: parseDateTime(get(map.date), get(map.prelimTime)),
        timezone: get(map.timezone) || 'UTC',
        city: get(map.city),
        country: get(map.country),
        bouts: [],
      });
    }

    grouped.get(eventId).bouts.push({
      boutType: get(map.boutType) || 'Undercard',
      fighterA: { name: aName, record: get(map.aRecord) },
      fighterB: { name: get(map.bName) || 'TBA', record: get(map.bRecord) },
      weightClass: get(map.weight),
    });
  }

  // Main Event first within each card
  for (const ev of grouped.values()) {
    ev.bouts.sort((a, b) => {
      const rank = (x) => (x.boutType === 'Main Event' ? 0 : x.boutType === 'Co-Main' ? 1 : 2);
      return rank(a) - rank(b);
    });
  }

  return Array.from(grouped.values());
}

/* ── JSON-LD: one SportsEvent per card ── */
function buildSchema(events) {
  return events.slice(0, 25).map((ev) => {
    const main = ev.bouts[0];
    const title = main ? `${main.fighterA.name} vs ${main.fighterB.name}` : ev.eventName;
    const node = {
      '@context': 'https://schema.org',
      '@type': 'SportsEvent',
      name: `${ev.eventName}: ${title}`,
      startDate: ev.datetime,
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
      sport: ev.sport === 'MMA' ? 'Mixed Martial Arts' : 'Boxing',
      url: `${SITE}/#${ev.id}`,
      location: {
        '@type': 'Place',
        name: ev.city || 'TBA',
        address: {
          '@type': 'PostalAddress',
          addressLocality: ev.city || undefined,
          addressCountry: ev.country || undefined,
        },
      },
    };
    if (ev.organization) {
      node.organizer = { '@type': 'Organization', name: ev.organization };
    }
    if (main) {
      node.competitor = [
        { '@type': 'Person', name: main.fighterA.name },
        { '@type': 'Person', name: main.fighterB.name },
      ];
    }
    return node;
  });
}

/* ── Static HTML crawlers can read with zero JavaScript ── */
function buildStaticHTML(events) {
  const now = new Date();
  const upcoming = events.filter((e) => new Date(e.datetime) > now);

  const rows = upcoming
    .map((ev) => {
      const main = ev.bouts[0];
      const title = main ? `${main.fighterA.name} vs ${main.fighterB.name}` : ev.eventName;
      const when = new Date(ev.datetime).toUTCString();
      const undercard = ev.bouts
        .slice(1)
        .map((b) => `<li>${b.fighterA.name} vs ${b.fighterB.name}${b.weightClass ? ' — ' + b.weightClass : ''}</li>`)
        .join('');
      return [
        '  <article>',
        `    <h3>${ev.eventName}: ${title}</h3>`,
        `    <p><strong>Start time:</strong> <time datetime="${ev.datetime}">${when}</time></p>`,
        `    <p><strong>Sport:</strong> ${ev.sport === 'MMA' ? 'MMA' : 'Boxing'}${ev.organization ? ' · ' + ev.organization : ''}</p>`,
        `    <p><strong>Location:</strong> ${[ev.city, ev.country].filter(Boolean).join(', ') || 'TBA'}</p>`,
        undercard ? `    <ul>${undercard}</ul>` : '',
        '  </article>',
      ].filter(Boolean).join('\n');
    })
    .join('\n');

  return [
    '<!-- Generated by prerender.js. Do not edit by hand. -->',
    '<section id="fight-schedule-static">',
    '  <h2>Upcoming Fight Schedule</h2>',
    rows || '  <p>No upcoming fights listed.</p>',
    '</section>',
    '',
  ].join('\n');
}

async function main() {
  const results = {};

  for (const sport of Object.keys(SHEETS)) {
    console.log(`Fetching ${sport}…`);
    const csv = await fetchCSV(SHEETS[sport]);
    assertLooksLikeCSV(csv, sport);
    const rows = parse(csv, { skip_empty_lines: true, relax_column_count: true });
    results[sport] = rowsToEvents(rows, sport);
    console.log(`  ${sport}: ${results[sport].length} events`);
  }

  const events = []
    .concat(results.MMA || [], results.BOXING || [])
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  // Safety valve: never overwrite good data with nothing.
  if (events.length === 0) {
    throw new Error('Parsed 0 events — refusing to overwrite existing files.');
  }

  fs.writeFileSync('fights.json', JSON.stringify(events, null, 2));
  console.log('✓ fights.json');

  fs.writeFileSync('schema-fights.json', JSON.stringify(buildSchema(events), null, 2));
  console.log('✓ schema-fights.json');

  fs.writeFileSync('fights-static.html', buildStaticHTML(events));
  console.log('✓ fights-static.html');

  console.log(`\n✅ Done — ${events.length} events pre-rendered.`);
}

main().catch((err) => {
  console.error('\n❌ Pre-render failed:', err.message);
  process.exit(1);
});
