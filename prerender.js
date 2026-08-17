/**
 * Walkout Watch — Enhanced pre-render with per-fight pages
 *
 * Generates:
 * 1. fights.json (existing)
 * 2. schema-fights.json (existing)
 * 3. fights-static.html (existing)
 * 4. /fights/[slug]/index.html (NEW) — individual fight pages for SEO
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
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

/* ── Date parsing ── */
function parseDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  const d = String(dateStr).trim();
  const t = String(timeStr || '').trim();

  let y, m, day;

  let match = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) { y = match[1]; m = match[2]; day = match[3]; }

  if (!y) {
    match = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (match) { m = match[1]; day = match[2]; y = match[3]; }
  }

  if (!y) {
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

/* ── Build column map by header name ── */
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

/* ── Static HTML crawlers can read ── */
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

/* ── Build schema for a single fight page ── */
function buildFightSchema(event, fight) {
  const fighter1 = fight.fighterA.name;
  const fighter2 = fight.fighterB.name;
  const title = `${fighter1} vs ${fighter2}`;

  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${event.eventName}: ${title}`,
    description: `Watch ${title} live. ${event.organization} ${event.sport} event on ${new Date(event.datetime).toDateString()} in ${event.city}, ${event.country}. ${fight.weightClass ? 'Weight class: ' + fight.weightClass + '. ' : ''}Countdown timer and fight start times available.`,
    startDate: event.datetime,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/MixedEventAttendanceMode',
    sport: event.sport === 'MMA' ? 'Mixed Martial Arts' : 'Boxing',
    url: `${SITE}/fights/${event.id}/`,
    location: {
      '@type': 'Place',
      name: event.city,
      address: {
        '@type': 'PostalAddress',
        addressLocality: event.city,
        addressCountry: event.country,
      },
    },
    performer: [
      { '@type': 'Person', name: fighter1 },
      { '@type': 'Person', name: fighter2 },
    ],
    organizer: {
      '@type': 'Organization',
      name: event.organization,
    },
  };
}

/* ── Generate HTML for a single fight page ── */
function buildFightPageHTML(event, allEvents) {
  const main = event.bouts[0];
  const fighter1 = main.fighterA.name;
  const fighter2 = main.fighterB.name;
  const title = `${fighter1} vs ${fighter2}`;
  const metaDesc = `Watch ${title} live on ${new Date(event.datetime).toDateString()}. ${event.sport} event in ${event.city}. Live countdown timer and start times.`;
  const schema = buildFightSchema(event, main);

  // Related fights: next 3 upcoming fights (excluding this one)
  const now = new Date();
  const upcoming = allEvents
    .filter(e => new Date(e.datetime) > now && e.id !== event.id)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
    .slice(0, 3);

  const relatedFightsHTML = upcoming
    .map(e => {
      const m = e.bouts[0];
      return `
      <div class="related-fight">
        <div class="related-fight-title">${m.fighterA.name} vs ${m.fighterB.name}</div>
        <div class="related-fight-meta">${e.eventName} · ${e.city}</div>
        <a href="/fights/${e.id}/" class="related-fight-link">View Fight →</a>
      </div>`;
    })
    .join('');

  const undercardsHTML = event.bouts
    .slice(1)
    .map(bout => `
    <div class="undercard-bout">
      <div class="bout-fighters">${bout.fighterA.name} vs ${bout.fighterB.name}</div>
      ${bout.weightClass ? `<div class="bout-weight">${bout.weightClass}</div>` : ''}
    </div>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - ${event.eventName} | Walkout Watch</title>
    <meta name="description" content="${metaDesc}">
    <meta name="keywords" content="${title}, ${event.sport}, fight countdown, ${event.city}, ${event.organization}">
    <link rel="canonical" href="${SITE}/fights/${event.id}/">

    <!-- Open Graph / Social Sharing -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="${SITE}/fights/${event.id}/">
    <meta property="og:title" content="${title} - ${event.eventName}">
    <meta property="og:description" content="${metaDesc}">
    <meta property="og:site_name" content="Walkout Watch">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${title} - Walkout Watch">
    <meta name="twitter:description" content="${metaDesc}">

    <!-- Schema.org markup -->
    <script type="application/ld+json">
    ${JSON.stringify(schema, null, 2)}
    </script>

    <!-- Styles -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&family=Share+Tech+Mono&family=Oswald:wght@700&display=swap" rel="stylesheet">
    <link rel="icon" type="image/png" href="/favicon.png" sizes="32x32">
    <style>
        :root {
            --bg-main: #07080a;
            --bg-card: #0d1017;
            --bg-meta: #090c10;
            --bg-control: #141923;
            --accent-volt: #ccff00;
            --accent-cyber: #00f0ff;
            --accent-red: #ff3c00;
            --text-primary: #ffffff;
            --text-muted: #5e687a;
            --transition: 0.15s cubic-bezier(0.2,0.8,0.2,1);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: var(--bg-main);
            background-image:
                linear-gradient(rgba(255,255,255,0.007) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.007) 1px, transparent 1px);
            background-size: 24px 24px;
            color: var(--text-primary);
            font-family: 'Inter', system-ui, sans-serif;
            padding: 3rem 1rem;
            line-height: 1.6;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
        }
        .back-link {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            color: var(--accent-cyber);
            text-decoration: none;
            margin-bottom: 2rem;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.85rem;
            letter-spacing: 1px;
        }
        .back-link:hover { text-decoration: underline; }

        .fight-header {
            margin-bottom: 3rem;
            padding: 2rem;
            background: var(--bg-card);
            border: 1px solid rgba(0,240,255,0.15);
            border-radius: 8px;
        }
        .sport-badge {
            display: inline-block;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.65rem;
            letter-spacing: 2px;
            text-transform: uppercase;
            padding: 0.4rem 0.8rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            background: rgba(0,240,255,0.1);
            color: var(--accent-cyber);
            border: 1px solid rgba(0,240,255,0.2);
        }
        .sport-badge.boxing {
            background: rgba(204,255,0,0.1);
            color: var(--accent-volt);
            border-color: rgba(204,255,0,0.2);
        }

        .event-title {
            font-family: 'Oswald', sans-serif;
            font-size: 2.5rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 1rem;
            line-height: 1.2;
        }
        .event-meta {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.85rem;
            color: var(--text-muted);
            display: flex;
            gap: 2rem;
            flex-wrap: wrap;
        }

        .countdown-section {
            background: var(--bg-card);
            border: 2px solid rgba(255,60,0,0.3);
            border-radius: 8px;
            padding: 2rem;
            margin-bottom: 3rem;
            text-align: center;
        }
        .countdown-label {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.8rem;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: var(--text-muted);
            margin-bottom: 1rem;
        }
        .countdown-display {
            font-family: 'Share Tech Mono', monospace;
            font-size: 3rem;
            font-weight: bold;
            color: var(--accent-red);
            letter-spacing: 2px;
            line-height: 1.2;
        }
        .countdown-display span {
            font-size: 0.8rem;
            margin-left: 0.5rem;
            color: var(--text-muted);
        }

        .fight-details {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 2rem;
            margin-bottom: 3rem;
        }
        .detail-box {
            background: var(--bg-card);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 6px;
            padding: 1.5rem;
        }
        .detail-label {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.7rem;
            letter-spacing: 2px;
            text-transform: uppercase;
            color: var(--text-muted);
            margin-bottom: 0.5rem;
        }
        .detail-value {
            font-size: 1.1rem;
            color: var(--text-primary);
        }

        .fighters-section {
            background: var(--bg-card);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 8px;
            padding: 2rem;
            margin-bottom: 3rem;
        }
        .fighters-title {
            font-family: 'Oswald', sans-serif;
            font-size: 1.3rem;
            letter-spacing: 1px;
            text-transform: uppercase;
            margin-bottom: 1.5rem;
            color: var(--accent-cyber);
        }
        .fighters-grid {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            gap: 2rem;
            align-items: center;
        }
        .fighter-box {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }
        .fighter-box.right { align-items: flex-end; text-align: right; }
        .fighter-name {
            font-family: 'Oswald', sans-serif;
            font-size: 1.8rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .fighter-record {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.8rem;
            color: var(--text-muted);
        }
        .vs-badge {
            text-align: center;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.9rem;
            color: var(--accent-red);
            font-weight: bold;
            letter-spacing: 2px;
        }

        .undercard-section {
            background: var(--bg-card);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 8px;
            padding: 2rem;
            margin-bottom: 3rem;
        }
        .undercard-title {
            font-family: 'Oswald', sans-serif;
            font-size: 1.3rem;
            letter-spacing: 1px;
            text-transform: uppercase;
            margin-bottom: 1.5rem;
            color: var(--text-muted);
        }
        .undercard-bout {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 1rem 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .undercard-bout:last-child { border-bottom: none; }
        .bout-fighters {
            font-size: 1rem;
            color: var(--text-primary);
        }
        .bout-weight {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.75rem;
            color: var(--text-muted);
            letter-spacing: 1px;
        }

        .related-section {
            background: rgba(0,240,255,0.05);
            border: 1px solid rgba(0,240,255,0.15);
            border-radius: 8px;
            padding: 2rem;
        }
        .related-title {
            font-family: 'Oswald', sans-serif;
            font-size: 1.2rem;
            letter-spacing: 1px;
            text-transform: uppercase;
            margin-bottom: 1.5rem;
            color: var(--accent-cyber);
        }
        .related-fights-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
        }
        .related-fight {
            background: var(--bg-card);
            border: 1px solid rgba(0,240,255,0.2);
            border-radius: 6px;
            padding: 1.2rem;
            transition: all var(--transition);
        }
        .related-fight:hover {
            border-color: rgba(0,240,255,0.5);
            box-shadow: 0 0 20px rgba(0,240,255,0.1);
        }
        .related-fight-title {
            font-family: 'Oswald', sans-serif;
            font-size: 0.95rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 0.5rem;
        }
        .related-fight-meta {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.7rem;
            color: var(--text-muted);
            margin-bottom: 0.8rem;
            letter-spacing: 0.5px;
        }
        .related-fight-link {
            display: inline-block;
            color: var(--accent-cyber);
            text-decoration: none;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.75rem;
            letter-spacing: 1px;
            transition: all var(--transition);
        }
        .related-fight-link:hover { color: var(--accent-volt); }

        .tickets-button {
            display: inline-block;
            background: linear-gradient(135deg, var(--accent-cyber), var(--accent-red));
            color: #000;
            padding: 0.8rem 1.6rem;
            border: none;
            border-radius: 4px;
            font-family: 'Oswald', sans-serif;
            font-size: 0.9rem;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
            cursor: pointer;
            text-decoration: none;
            transition: all var(--transition);
            margin-bottom: 3rem;
        }
        .tickets-button:hover {
            transform: scale(1.05);
            box-shadow: 0 0 20px rgba(0,240,255,0.3);
        }

        @media (max-width: 768px) {
            .fight-details { grid-template-columns: 1fr; }
            .fighters-grid { grid-template-columns: 1fr; }
            .event-title { font-size: 1.8rem; }
            .countdown-display { font-size: 2rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <a href="/" class="back-link">← Back to Schedule</a>

        <div class="fight-header">
            <div class="sport-badge ${event.sport === 'MMA' ? 'mma' : 'boxing'}">
                ${event.sport === 'MMA' ? '🥊 MMA' : '🥊 Boxing'}
            </div>
            <h1 class="event-title">${title}</h1>
            <div class="event-meta">
                <span>${event.eventName}</span>
                <span>${event.organization}</span>
                <span>${event.city}, ${event.country}</span>
            </div>
        </div>

        <div class="countdown-section">
            <div class="countdown-label">Time Until Main Event</div>
            <div class="countdown-display" id="countdown">-- : -- : -- : --</div>
        </div>

        <a href="https://www.google.com/search?q=${encodeURIComponent(title + ' tickets')}" class="tickets-button" target="_blank">Get Tickets</a>

        <div class="fight-details">
            <div class="detail-box">
                <div class="detail-label">Main Event Time</div>
                <div class="detail-value" id="main-time">${new Date(event.datetime).toUTCString()}</div>
            </div>
            <div class="detail-box">
                <div class="detail-label">Prelim Time</div>
                <div class="detail-value" id="prelim-time">${event.prelimDatetime ? new Date(event.prelimDatetime).toUTCString() : 'TBA'}</div>
            </div>
            <div class="detail-box">
                <div class="detail-label">Weight Class</div>
                <div class="detail-value">${main.weightClass || 'TBA'}</div>
            </div>
        </div>

        <div class="fighters-section">
            <h2 class="fighters-title">Main Event Fighters</h2>
            <div class="fighters-grid">
                <div class="fighter-box">
                    <div class="fighter-name">${main.fighterA.name}</div>
                    ${main.fighterA.record ? `<div class="fighter-record">Record: ${main.fighterA.record}</div>` : ''}
                </div>
                <div class="vs-badge">VS</div>
                <div class="fighter-box right">
                    <div class="fighter-name">${main.fighterB.name}</div>
                    ${main.fighterB.record ? `<div class="fighter-record">Record: ${main.fighterB.record}</div>` : ''}
                </div>
            </div>
        </div>

        ${undercardsHTML ? `
        <div class="undercard-section">
            <h2 class="undercard-title">Undercard</h2>
            ${undercardsHTML}
        </div>
        ` : ''}

        ${relatedFightsHTML ? `
        <div class="related-section">
            <h2 class="related-title">Upcoming Fights</h2>
            <div class="related-fights-grid">
                ${relatedFightsHTML}
            </div>
        </div>
        ` : ''}
    </div>

    <script>
        function formatCountdown(ms) {
            if (ms <= 0) return null;
            const total = Math.floor(ms / 1000);
            const days = Math.floor(total / 86400);
            const hours = Math.floor((total % 86400) / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            const seconds = total % 60;
            return \`\${String(days).padStart(2,'0')}d \${String(hours).padStart(2,'0')}h \${String(minutes).padStart(2,'0')}m \${String(seconds).padStart(2,'0')}s\`;
        }

        const mainDate = new Date('${event.datetime}');
        const countdownEl = document.getElementById('countdown');

        function updateCountdown() {
            const diff = mainDate - Date.now();
            if (diff > 0) {
                const days  = Math.floor(diff / 86400000);
                const hours = Math.floor((diff % 86400000) / 3600000);
                const mins  = Math.floor((diff % 3600000) / 60000);
                const secs  = Math.floor((diff % 60000) / 1000);
                countdownEl.textContent = \`\${String(days).padStart(2,'0')}<span>d</span> \${String(hours).padStart(2,'0')}<span>h</span> \${String(mins).padStart(2,'0')}<span>m</span> \${String(secs).padStart(2,'0')}<span>s</span>\`;
            } else {
                countdownEl.innerHTML = '<span style="color:var(--accent-red)">LIVE NOW</span>';
            }
        }

        updateCountdown();
        setInterval(updateCountdown, 1000);
    </script>
</body>
</html>`;
}

async function main() {
  const results = {};

  for (const sport of Object.keys(SHEETS)) {
    console.log('Fetching ' + sport + '…');
    const csv = await fetchCSV(SHEETS[sport]);
    assertLooksLikeCSV(csv, sport);
    const rows = parse(csv, { skip_empty_lines: true, relax_column_count: true });
    results[sport] = rowsToEvents(rows, sport);
    console.log('  ' + sport + ': ' + results[sport].length + ' events');
  }

  const events = []
    .concat(results.MMA || [], results.BOXING || [])
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (events.length === 0) {
    throw new Error('Parsed 0 events — refusing to overwrite existing files.');
  }

  // Generate existing files
  fs.writeFileSync('fights.json', JSON.stringify(events, null, 2));
  console.log('✓ fights.json');

  fs.writeFileSync('schema-fights.json', JSON.stringify(buildSchema(events), null, 2));
  console.log('✓ schema-fights.json');

  fs.writeFileSync('fights-static.html', buildStaticHTML(events));
  console.log('✓ fights-static.html');

  // Generate per-fight pages
  const fightsDir = path.join(process.cwd(), 'fights');
  if (!fs.existsSync(fightsDir)) {
    fs.mkdirSync(fightsDir, { recursive: true });
  }

  let pagesGenerated = 0;
  for (const event of events) {
    const eventDir = path.join(fightsDir, event.id);
    if (!fs.existsSync(eventDir)) {
      fs.mkdirSync(eventDir, { recursive: true });
    }

    const indexPath = path.join(eventDir, 'index.html');
    const html = buildFightPageHTML(event, events);
    fs.writeFileSync(indexPath, html);
    pagesGenerated++;
  }
  console.log('✓ /fights/[slug]/index.html × ' + pagesGenerated);

  console.log('\n✅ Done — ' + events.length + ' events pre-rendered (' + pagesGenerated + ' fight pages).');
}

main().catch((err) => {
  console.error('\n❌ Pre-render failed:', err.message);
  process.exit(1);
});
