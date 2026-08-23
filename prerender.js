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

/* ── Breadcrumb schema for a single fight page ── */
function buildBreadcrumbSchema(event, title) {
  const isMMA = event.sport === 'MMA';
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: isMMA ? 'MMA' : 'Boxing', item: `${SITE}/#${isMMA ? 'mma' : 'boxing'}` },
      { '@type': 'ListItem', position: 3, name: title, item: `${SITE}/fights/${event.id}/` },
    ],
  };
}

/* ── FAQ schema for a single fight page (mirrors visible FAQ section) ── */
function buildFAQSchema(event, main, title) {
  const faqs = [
    {
      q: `What time does ${title} start?`,
      a: `The main card for ${title} starts at ${new Date(event.datetime).toUTCString()}. A live countdown on this page shows the exact time remaining in your local timezone.`,
    },
  ];
  if (event.prelimDatetime) {
    faqs.push({
      q: 'When do the prelims start?',
      a: `Preliminary bouts for ${event.eventName} begin at ${new Date(event.prelimDatetime).toUTCString()}, ahead of the main card.`,
    });
  }
  faqs.push({
    q: `Where is ${event.eventName} taking place?`,
    a: event.city
      ? `This event takes place in ${[event.city, event.country].filter(Boolean).join(', ')}.`
      : 'Location details for this event will be announced closer to the date.',
  });
  faqs.push({
    q: 'Who else is fighting on the card?',
    a: event.bouts.length > 1
      ? `${event.eventName} features ${event.bouts.length} total bouts, including the main event and undercard fights.`
      : `${title} is currently the only announced bout for this event.`,
  });

  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

/* ── Generate HTML for a single fight page ── */
function buildFightPageHTML(event, allEvents) {
  const main = event.bouts[0];
  const fighter1 = main.fighterA.name;
  const fighter2 = main.fighterB.name;
  const title = `${fighter1} vs ${fighter2}`;
  const isMMA = event.sport === 'MMA';
  const sportLabel = isMMA ? 'MMA' : 'Boxing';
  const metaDesc = `Watch ${title} live on ${new Date(event.datetime).toDateString()}. ${sportLabel} event in ${event.city || 'TBA'}. Live countdown timer, start times, and full fight card.`;
  const schema = buildFightSchema(event, main);
  const breadcrumbSchema = buildBreadcrumbSchema(event, title);
  const faqSchema = buildFAQSchema(event, main, title);

  // Related fights: next 4 upcoming fights (excluding this one), prefer same sport first
  const now = new Date();
  const upcomingAll = allEvents
    .filter(e => new Date(e.datetime) > now && e.id !== event.id)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
  const sameSport = upcomingAll.filter(e => e.sport === event.sport);
  const otherSport = upcomingAll.filter(e => e.sport !== event.sport);
  const upcoming = [...sameSport, ...otherSport].slice(0, 4);

  const relatedFightsHTML = upcoming
    .map(e => {
      const m = e.bouts[0];
      const eIsMMA = e.sport === 'MMA';
      return `
        <a href="/fights/${e.id}/" class="related-fight ${eIsMMA ? 'mma' : 'boxing'}">
          <div class="related-fight-sport">${eIsMMA ? 'MMA' : 'Boxing'}</div>
          <div class="related-fight-title">${m.fighterA.name} <span>vs</span> ${m.fighterB.name}</div>
          <div class="related-fight-meta">${e.eventName}${e.city ? ' · ' + e.city : ''}</div>
          <time class="related-fight-date" datetime="${e.datetime}">${new Date(e.datetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</time>
        </a>`;
    })
    .join('');

  // Split names at last space for two-line display (matches homepage)
  function splitName(n) {
    const parts = String(n || '').trim().split(' ');
    if (parts.length === 1) return [parts[0] || '', ''];
    const last = parts.pop();
    return [parts.join(' '), last];
  }
  const [faFirst, faLast] = splitName(fighter1);
  const [fbFirst, fbLast] = splitName(fighter2);

  const mainDate = new Date(event.datetime);
  const prelimDate = event.prelimDatetime ? new Date(event.prelimDatetime) : new Date(mainDate - 3 * 3600000);

  // Full fight card list — mirrors homepage's undercard drawer, always expanded on the dedicated page
  const bouts = event.bouts
    .map((b, idx) => {
      const boutLabel = idx === 0 ? 'Main Event' : (b.boutType || (idx === 1 ? 'Co-Main' : 'Undercard'));
      return `
                    <li class="undercard-row">
                        <div class="bout-info">
                            <span class="bout-type-tag">${boutLabel}</span>
                            <span class="bout-fighters">
                                ${b.fighterA.name}${b.fighterA.record ? ` <span class="fighter-rec">(${b.fighterA.record})</span>` : ''}
                                <span class="uc-vs">VS</span>
                                ${b.fighterB.name}${b.fighterB.record ? ` <span class="fighter-rec">(${b.fighterB.record})</span>` : ''}
                            </span>
                        </div>
                        ${b.weightClass ? `<span class="weight-tag">${b.weightClass.toUpperCase()}</span>` : ''}
                    </li>`;
    })
    .join('');

  const totalBouts = event.bouts.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} — Start Time &amp; Countdown | ${event.eventName} | Walkout Watch</title>
    <meta name="description" content="${metaDesc}">
    <meta name="keywords" content="${title}, ${title} start time, ${sportLabel}, fight countdown, ${event.city || ''}, ${event.organization || ''}">
    <link rel="canonical" href="${SITE}/fights/${event.id}/">
    <meta name="robots" content="index, follow, max-image-preview:large">
    <meta name="theme-color" content="#07080a">
    <meta name="author" content="Walkout Watch">
    <meta name="publisher" content="Walkout Watch">

    <!-- Open Graph / Social Sharing -->
    <meta property="og:type" content="article">
    <meta property="og:url" content="${SITE}/fights/${event.id}/">
    <meta property="og:title" content="${title} — ${event.eventName}">
    <meta property="og:description" content="${metaDesc}">
    <meta property="og:site_name" content="Walkout Watch">
    <meta property="og:image" content="${SITE}/favicon-512.png">
    <meta property="og:image:width" content="512">
    <meta property="og:image:height" content="512">
    <meta property="article:published_time" content="${new Date().toISOString()}">
    <meta property="og:locale" content="en_US">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary">
    <meta name="twitter:title" content="${title} — Walkout Watch">
    <meta name="twitter:description" content="${metaDesc}">
    <meta name="twitter:image" content="${SITE}/favicon-512.png">

    <!-- Schema.org markup -->
    <script type="application/ld+json">
    ${JSON.stringify(schema, null, 2)}
    </script>
    <script type="application/ld+json">
    ${JSON.stringify(breadcrumbSchema, null, 2)}
    </script>
    <script type="application/ld+json">
    ${JSON.stringify(faqSchema, null, 2)}
    </script>

    <!-- Styles -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Share+Tech+Mono&family=Oswald:wght@600;700&display=swap" rel="stylesheet">
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
            --border-mma: rgba(0,240,255,0.12);
            --border-boxing: rgba(204,255,0,0.12);
            --transition: 0.15s cubic-bezier(0.2,0.8,0.2,1);
            /* Sport accent — set per-page below */
            --accent-sport: ${isMMA ? 'var(--accent-cyber)' : 'var(--accent-volt)'};
            --accent-sport-rgb: ${isMMA ? '0,240,255' : '204,255,0'};
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html { scroll-behavior: smooth; }
        @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0.15; } }
        body {
            background-color: var(--bg-main);
            background-image:
                linear-gradient(rgba(255,255,255,0.007) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255,255,255,0.007) 1px, transparent 1px);
            background-size: 24px 24px;
            color: var(--text-primary);
            font-family: 'Inter', system-ui, sans-serif;
            line-height: 1.6;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* ── SITE HEADER (branding, exact match to homepage) ── */
        .site-header {
            border-bottom: 1px solid rgba(255,255,255,0.06);
            background: rgba(7,8,10,0.85);
            backdrop-filter: blur(8px);
            position: sticky;
            top: 0;
            z-index: 20;
        }
        .site-header-inner {
            max-width: 980px;
            margin: 0 auto;
            padding: 1rem 1.25rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
        }
        .brand-link {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            text-decoration: none;
            flex-shrink: 0;
        }
        .brand-logo-wrap {
            display: flex;
            flex-direction: column;
        }
        .brand-logo-line {
            display: flex;
            align-items: center;
            gap: 0.35rem;
            line-height: 1;
        }
        .brand-logo-line + .brand-logo-line { margin-top: -0.15rem; }
        .brand-word {
            font-family: 'Oswald', sans-serif;
            font-size: 1.05rem;
            font-weight: 700;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            line-height: 1;
        }
        .brand-word.walkout { color: var(--accent-volt); }
        .brand-word.watch   { color: var(--accent-cyber); }
        .brand-oct {
            width: 12px; height: 12px;
            background: var(--accent-cyber);
            clip-path: polygon(30% 0%,70% 0%,100% 30%,100% 70%,70% 100%,30% 100%,0% 70%,0% 30%);
            flex-shrink: 0;
        }
        .brand-sq {
            width: 10px; height: 10px;
            background: var(--accent-volt);
            border-radius: 2px;
            flex-shrink: 0;
        }
        .header-nav {
            display: flex;
            align-items: center;
            gap: 1.25rem;
            flex-wrap: wrap;
        }
        .header-nav a {
            color: var(--text-muted);
            text-decoration: none;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.68rem;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            transition: color var(--transition);
        }
        .header-nav a:hover { color: var(--text-primary); }
        .header-nav a.all-fights {
            color: var(--accent-sport);
            border: 1px solid rgba(var(--accent-sport-rgb),0.3);
            padding: 0.45rem 0.9rem;
            border-radius: 4px;
        }
        .header-nav a.all-fights:hover {
            background: rgba(var(--accent-sport-rgb),0.08);
            border-color: rgba(var(--accent-sport-rgb),0.6);
        }

        /* ── HEADER TIMEZONE SWITCHER (matches homepage) ── */
        .tz-switcher {
            display: flex;
            background: #090c10;
            padding: 3px;
            border-radius: 4px;
            border: 1px solid rgba(255,255,255,0.05);
        }
        .zone-btn {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 0.4rem 0.65rem;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.65rem;
            letter-spacing: 1px;
            border-radius: 2px;
            cursor: pointer;
            transition: all var(--transition);
        }
        .zone-btn:hover { color: var(--text-primary); }
        .zone-btn.active {
            background: var(--bg-control);
            color: var(--accent-red);
            border: 1px solid rgba(255,60,0,0.2);
        }

        /* ── BREADCRUMBS (SEO + orientation) ── */
        .breadcrumbs {
            max-width: 980px;
            margin: 0 auto;
            padding: 1.25rem 1.25rem 0;
            width: 100%;
        }
        .breadcrumbs ol {
            list-style: none;
            display: flex;
            flex-wrap: wrap;
            gap: 0.4rem;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.7rem;
            letter-spacing: 0.5px;
            color: var(--text-muted);
        }
        .breadcrumbs a { color: var(--text-muted); text-decoration: none; }
        .breadcrumbs a:hover { color: var(--accent-sport); }
        .breadcrumbs li:not(:last-child)::after { content: '/'; margin-left: 0.4rem; opacity: 0.4; }
        .breadcrumbs li[aria-current] { color: var(--text-primary); }

        main { flex: 1; }

        .page-wrap {
            max-width: 980px;
            margin: 0 auto;
            padding: 1.5rem 1.25rem 4rem;
        }

        /* ═══════════════════════════════════════════════════
           FIGHT CARD — copied 1:1 from homepage's card component
           ═══════════════════════════════════════════════════ */
        .fight-card {
            background: var(--bg-card);
            border-radius: 6px;
            border: 1px solid var(--border-mma);
            overflow: hidden;
            box-shadow: 0 12px 40px rgba(0,0,0,0.7), 0 0 30px rgba(0,240,255,0.05);
            position: relative;
            margin-bottom: 1.5rem;
        }
        .fight-card.boxing-card { border-color: var(--border-boxing); }
        .card-accent-bar { height: 3px; width: 100%; }
        .mma-card    .card-accent-bar { background: var(--accent-cyber); }
        .boxing-card .card-accent-bar { background: var(--accent-volt); }

        .card-trigger { padding: 1.75rem 2rem 0; }
        .card-org-row {
            display: flex; align-items: center;
            justify-content: space-between;
            margin-bottom: 1.25rem;
        }
        .org-tag {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.68rem; letter-spacing: 2px; text-transform: uppercase;
            color: var(--accent-cyber);
        }
        .boxing-card .org-tag { color: var(--accent-volt); }
        .card-emblem { display: flex; align-items: center; gap: 0.5rem; opacity: 0.25; }
        .emblem-octagon {
            width: 26px; height: 26px;
            background: var(--accent-cyber);
            clip-path: polygon(30% 0%,70% 0%,100% 30%,100% 70%,70% 100%,30% 100%,0% 70%,0% 30%);
        }
        .boxing-card .emblem-octagon { display: none; }
        .emblem-glove {
            display: none;
            width: 23px; height: 23px;
            background: var(--accent-volt);
            border-radius: 2px;
        }
        .boxing-card .emblem-glove { display: block; }

        .fighters-grid {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            align-items: center;
            gap: 1rem;
            margin-bottom: 1.5rem;
        }
        .fighter-block { display: flex; flex-direction: column; gap: 0.3rem; }
        .fighter-block.right { align-items: flex-end; text-align: right; }
        .fighter-name {
            font-family: 'Oswald', sans-serif;
            font-size: 2.3rem; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.5px;
            line-height: 1.05; color: var(--text-primary);
        }
        .fighter-record {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.68rem; color: var(--text-muted); letter-spacing: 1px;
        }
        .vs-block { text-align: center; flex-shrink: 0; }
        .vs-pill {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.72rem; letter-spacing: 3px;
            color: var(--accent-red);
            background: rgba(255,60,0,0.08);
            border: 1px solid rgba(255,60,0,0.22);
            border-radius: 3px; padding: 0.4rem 0.55rem;
            display: block;
        }

        .countdown-divider { height: 1px; background: rgba(255,255,255,0.04); margin: 0 2rem; }
        .countdown-row { display: grid; grid-template-columns: 1fr 1fr; }
        .countdown-cell { padding: 1.2rem 2rem; border-right: 1px solid rgba(255,255,255,0.04); }
        .clock-label {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.75rem; letter-spacing: 2px; color: #ffffff;
            text-transform: uppercase; margin-bottom: 0.4rem;
            display: flex; align-items: center; gap: 0.45rem;
        }
        .pulse-dot {
            width: 5px; height: 5px; border-radius: 50%;
            background: var(--accent-red); flex-shrink: 0;
            animation: blink 1.4s infinite steps(1);
        }
        .clock-display {
            font-family: 'Share Tech Mono', monospace;
            font-size: 1.85rem; letter-spacing: 1px;
            line-height: 1;
            color: #ff3c00;
            text-shadow: 0 0 12px rgba(255,60,0,0.3);
        }
        .time-unit { font-size: 0.85rem; color: #ff3c00; margin: 0 3px 0 1px; }
        .fight-time-display {
            font-family: 'Share Tech Mono', monospace;
            font-size: 1.85rem;
            font-weight: bold;
            letter-spacing: 1px;
            line-height: 1;
            color: var(--accent-cyber);
            margin-top: 0.5rem;
        }
        .fight-time-display.boxing-time { color: var(--accent-volt); }

        .card-meta {
            display: flex; align-items: center;
            gap: 1.25rem; flex-wrap: wrap;
            padding: 1rem 2rem;
            background: var(--bg-meta);
            border-top: 1px solid rgba(255,255,255,0.05);
        }
        .meta-chip {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.85rem; letter-spacing: 1px; color: #aab4c4;
            display: flex; align-items: center; gap: 0.4rem;
        }
        .meta-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--text-muted); opacity: 0.5; }

        .undercard-content { padding: 1.5rem 2rem 1.75rem; border-top: 1px solid rgba(255,255,255,0.04); }
        .undercard-title {
            font-family: 'Share Tech Mono', monospace; font-size: 0.65rem;
            letter-spacing: 2.5px; text-transform: uppercase; margin-bottom: 1rem;
            color: var(--accent-cyber);
        }
        .boxing-card .undercard-title { color: var(--accent-volt); }
        .undercard-list { list-style: none; display: grid; grid-template-columns: repeat(2,1fr); gap: 0.6rem; }
        .undercard-row {
            background: rgba(255,255,255,0.015); border: 1px solid rgba(255,255,255,0.04);
            border-radius: 3px; padding: 0.7rem 1rem;
            display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem;
        }
        .bout-info { display: flex; flex-direction: column; gap: 0.2rem; }
        .bout-type-tag {
            font-family: 'Share Tech Mono', monospace; font-size: 0.55rem;
            letter-spacing: 1.5px; color: var(--accent-red); text-transform: uppercase;
        }
        .bout-fighters {
            font-size: 0.85rem;
            color: var(--text-primary);
        }
        .uc-vs { color: var(--text-muted); font-size: 0.7rem; margin: 0 0.3rem; font-family: 'Share Tech Mono', monospace; }
        .fighter-rec { font-family: 'Share Tech Mono', monospace; font-size: 0.65rem; color: var(--text-muted); }
        .weight-tag {
            font-family: 'Share Tech Mono', monospace; font-size: 0.62rem;
            color: var(--text-muted); background: rgba(255,255,255,0.03);
            padding: 0.2rem 0.5rem; border-radius: 2px; white-space: nowrap; flex-shrink: 0;
        }

        .action-row {
            display: flex;
            gap: 0.75rem;
            flex-wrap: wrap;
            margin-bottom: 1.5rem;
        }
        .tickets-button {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: linear-gradient(135deg, var(--accent-sport), var(--accent-red));
            color: #000;
            padding: 0.85rem 1.6rem;
            border: none;
            border-radius: 6px;
            font-family: 'Oswald', sans-serif;
            font-size: 0.85rem;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
            cursor: pointer;
            text-decoration: none;
            transition: all var(--transition);
        }
        .tickets-button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 20px rgba(var(--accent-sport-rgb),0.35);
        }
        .share-button {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: transparent;
            color: var(--text-muted);
            padding: 0.85rem 1.4rem;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 6px;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.75rem;
            letter-spacing: 1px;
            text-transform: uppercase;
            cursor: pointer;
            text-decoration: none;
            transition: all var(--transition);
        }
        .share-button:hover { color: var(--text-primary); border-color: rgba(255,255,255,0.25); }

        /* ── SECTION LABEL PATTERN ── */
        .section {
            background: var(--bg-card);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 10px;
            padding: 1.75rem 2rem;
            margin-bottom: 1.5rem;
        }
        .section-title {
            font-family: 'Oswald', sans-serif;
            font-size: 1.05rem;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            margin-bottom: 1.25rem;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 0.6rem;
        }
        .section-title .bar { width: 3px; height: 14px; background: var(--accent-sport); border-radius: 1px; }
        .section-title.accent { color: var(--accent-sport); }

        /* ── FAQ (SEO: matches common searches, also visually useful) ── */
        .faq-item { padding: 1rem 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
        .faq-item:last-child { border-bottom: none; }
        .faq-q {
            font-family: 'Inter', sans-serif;
            font-size: 0.95rem;
            font-weight: 600;
            color: var(--text-primary);
            margin-bottom: 0.4rem;
        }
        .faq-a {
            font-size: 0.88rem;
            color: var(--text-muted);
            line-height: 1.6;
        }

        /* ── RELATED FIGHTS ── */
        .related-fights-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 0.9rem;
        }
        .related-fight {
            display: block;
            background: var(--bg-meta);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 8px;
            padding: 1.1rem;
            text-decoration: none;
            color: inherit;
            transition: all var(--transition);
            position: relative;
        }
        .related-fight.mma:hover { border-color: rgba(0,240,255,0.45); box-shadow: 0 0 20px rgba(0,240,255,0.1); }
        .related-fight.boxing:hover { border-color: rgba(204,255,0,0.45); box-shadow: 0 0 20px rgba(204,255,0,0.1); }
        .related-fight-sport {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.62rem;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            margin-bottom: 0.6rem;
        }
        .related-fight.mma .related-fight-sport { color: var(--accent-cyber); }
        .related-fight.boxing .related-fight-sport { color: var(--accent-volt); }
        .related-fight-title {
            font-family: 'Oswald', sans-serif;
            font-size: 0.9rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            margin-bottom: 0.5rem;
            line-height: 1.3;
        }
        .related-fight-title span { color: var(--text-muted); font-size: 0.75rem; margin: 0 0.15rem; }
        .related-fight-meta {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.68rem;
            color: var(--text-muted);
            margin-bottom: 0.6rem;
        }
        .related-fight-date {
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.68rem;
            color: var(--text-muted);
            letter-spacing: 1px;
        }

        /* ── FOOTER ── */
        .site-footer {
            border-top: 1px solid rgba(255,255,255,0.06);
            padding: 2rem 1.25rem;
            margin-top: auto;
        }
        .site-footer-inner {
            max-width: 980px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 1rem;
        }
        .footer-brand {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.7rem;
            color: var(--text-muted);
            letter-spacing: 1px;
        }
        .footer-links {
            display: flex;
            gap: 1.25rem;
            font-family: 'Share Tech Mono', monospace;
            font-size: 0.68rem;
        }
        .footer-links a { color: var(--text-muted); text-decoration: none; letter-spacing: 0.5px; }
        .footer-links a:hover { color: var(--text-primary); }

        @media (max-width: 768px) {
            .fighters-grid { grid-template-columns: 1fr; text-align: center; }
            .fighter-block.right { align-items: center; text-align: center; }
            .countdown-row { grid-template-columns: 1fr; }
            .countdown-cell { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.04); }
            .undercard-list { grid-template-columns: 1fr; }
            .site-header-inner { flex-wrap: wrap; }
            .header-nav { gap: 1rem; }
            .action-row { flex-direction: column; }
            .tickets-button, .share-button { justify-content: center; }
            .fighter-name { font-size: 1.7rem; }
        }
    </style>
</head>
<body>

    <header class="site-header">
        <div class="site-header-inner">
            <a href="/" class="brand-link">
                <div class="brand-logo-wrap">
                    <div class="brand-logo-line">
                        <span class="brand-word walkout">WALKOUT</span>
                        <div class="brand-oct"></div>
                    </div>
                    <div class="brand-logo-line">
                        <span class="brand-word watch">WATCH</span>
                        <div class="brand-sq"></div>
                    </div>
                </div>
            </a>
            <nav class="header-nav">
                <div class="tz-switcher" id="header-tz-switcher">
                    <button class="zone-btn" data-tz="America/Los_Angeles">PT</button>
                    <button class="zone-btn" data-tz="America/Denver">MT</button>
                    <button class="zone-btn" data-tz="America/Chicago">CT</button>
                    <button class="zone-btn" data-tz="America/New_York">ET</button>
                    <button class="zone-btn" data-tz="Europe/London">BST</button>
                </div>
                <a href="/about.html">About</a>
                <a href="/" class="all-fights">All Fights →</a>
            </nav>
        </div>
    </header>

    <nav class="breadcrumbs" aria-label="Breadcrumb">
        <ol>
            <li><a href="/">Home</a></li>
            <li><a href="/#${isMMA ? 'mma' : 'boxing'}">${sportLabel}</a></li>
            <li aria-current="page">${fighter1} vs ${fighter2}</li>
        </ol>
    </nav>

    <main>
        <div class="page-wrap">

            <h1 style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);">${title} — ${event.eventName}</h1>

            <div class="fight-card ${isMMA ? 'mma-card' : 'boxing-card'}">
                <div class="card-accent-bar"></div>
                <div class="card-trigger">
                    <div class="card-org-row">
                        <span class="org-tag">${event.organization || sportLabel}</span>
                        <div class="card-emblem">
                            <div class="emblem-octagon"></div>
                            <div class="emblem-glove"></div>
                        </div>
                    </div>
                    <div class="fighters-grid">
                        <div class="fighter-block">
                            <div class="fighter-name">${faFirst}${faLast ? '<br>' + faLast : ''}</div>
                            ${main.fighterA.record ? `<div class="fighter-record">${main.fighterA.record}</div>` : ''}
                        </div>
                        <div class="vs-block"><span class="vs-pill">VS</span></div>
                        <div class="fighter-block right">
                            <div class="fighter-name">${fbFirst}${fbLast ? '<br>' + fbLast : ''}</div>
                            ${main.fighterB.record ? `<div class="fighter-record">${main.fighterB.record}</div>` : ''}
                        </div>
                    </div>
                </div>
                <div class="countdown-divider"></div>
                <div class="countdown-row">
                    <div class="countdown-cell">
                        <div class="clock-label"><div class="pulse-dot"></div>PRELIM START</div>
                        <div class="clock-display" id="prelim-clock">--<span class="time-unit">d</span>--<span class="time-unit">h</span>--<span class="time-unit">m</span>--<span class="time-unit">s</span></div>
                        <div class="fight-time-display ${isMMA ? '' : 'boxing-time'}" id="prelim-time">${prelimDate.toUTCString()}</div>
                    </div>
                    <div class="countdown-cell">
                        <div class="clock-label"><div class="pulse-dot"></div>MAIN EVENT WALKOUT</div>
                        <div class="clock-display" id="main-clock">--<span class="time-unit">d</span>--<span class="time-unit">h</span>--<span class="time-unit">m</span>--<span class="time-unit">s</span></div>
                        <div class="fight-time-display ${isMMA ? '' : 'boxing-time'}" id="main-time">${mainDate.toUTCString()}</div>
                    </div>
                </div>
                <div class="card-meta">
                    <span class="meta-chip">🗓 <span id="meta-date">${mainDate.toDateString()}</span></span>
                    <span class="meta-dot"></span>
                    <span class="meta-chip">📍 ${[event.city, event.country].filter(Boolean).join(', ') || 'TBA'}</span>
                    <span class="meta-dot"></span>
                    <span class="meta-chip">${totalBouts} bout${totalBouts !== 1 ? 's' : ''} on the card</span>
                </div>
                <div class="undercard-content">
                    <div class="undercard-title">Full Fight Card</div>
                    <ul class="undercard-list">${bouts}</ul>
                </div>
            </div>

            <div class="action-row">
                <a href="https://www.google.com/search?q=${encodeURIComponent(title + ' tickets')}" class="tickets-button" target="_blank" rel="noopener">🎟 Get Tickets</a>
                <a href="https://www.google.com/search?q=${encodeURIComponent(title + ' live stream')}" class="share-button" target="_blank" rel="noopener">▶ Where to Watch</a>
            </div>

            <div class="section">
                <h2 class="section-title"><span class="bar"></span>Frequently Asked Questions</h2>
                <div class="faq-item">
                    <div class="faq-q">What time does ${title} start?</div>
                    <div class="faq-a">The main card for ${title} starts at <strong>${new Date(event.datetime).toUTCString()}</strong>. Use the live countdown above to see the exact time remaining in your local timezone.</div>
                </div>
                ${event.prelimDatetime ? `
                <div class="faq-item">
                    <div class="faq-q">When do the prelims start?</div>
                    <div class="faq-a">Preliminary bouts for ${event.eventName} begin at <strong>${new Date(event.prelimDatetime).toUTCString()}</strong>, ahead of the main card.</div>
                </div>
                ` : ''}
                <div class="faq-item">
                    <div class="faq-q">Where is ${event.eventName} taking place?</div>
                    <div class="faq-a">${event.city ? `This event takes place in ${[event.city, event.country].filter(Boolean).join(', ')}.` : 'Location details for this event will be announced closer to the date.'}</div>
                </div>
                <div class="faq-item">
                    <div class="faq-q">Who else is fighting on the card?</div>
                    <div class="faq-a">${totalBouts > 1 ? `${event.eventName} features ${totalBouts} total bouts, including the main event and undercard fights listed above.` : `${title} is currently the only announced bout for this event.`}</div>
                </div>
            </div>

            ${relatedFightsHTML ? `
            <div class="section">
                <h2 class="section-title accent"><span class="bar"></span>More Upcoming Fights</h2>
                <div class="related-fights-grid">
                    ${relatedFightsHTML}
                </div>
            </div>
            ` : ''}

        </div>
    </main>

    <footer class="site-footer">
        <div class="site-footer-inner">
            <div class="footer-brand">
                <div class="brand-oct" style="width:10px;height:10px;"></div>
                WALKOUT WATCH · Live fight countdowns &amp; schedules
            </div>
            <div class="footer-links">
                <a href="/about.html">About</a>
                <a href="/contact.html">Contact</a>
                <a href="/privacy.html">Privacy</a>
                <a href="/terms.html">Terms</a>
            </div>
        </div>
    </footer>

    <script>
        const mainDate = new Date('${event.datetime}');
        const prelimDate = new Date('${prelimDate.toISOString()}');
        const mainClockEl = document.getElementById('main-clock');
        const prelimClockEl = document.getElementById('prelim-clock');
        const mainTimeEl = document.getElementById('main-time');
        const prelimTimeEl = document.getElementById('prelim-time');
        const metaDateEl = document.getElementById('meta-date');

        function formatCountdown(ms) {
            if (ms <= 0) return null;
            const total = Math.floor(ms / 1000);
            const days = Math.floor(total / 86400);
            const hours = Math.floor((total % 86400) / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            const seconds = total % 60;
            return \`\${String(days).padStart(2,'0')}<span class="time-unit">d</span>\${String(hours).padStart(2,'0')}<span class="time-unit">h</span>\${String(minutes).padStart(2,'0')}<span class="time-unit">m</span>\${String(seconds).padStart(2,'0')}<span class="time-unit">s</span>\`;
        }

        function tick() {
            const now = Date.now();
            const mainF = formatCountdown(mainDate - now);
            const prelimF = formatCountdown(prelimDate - now);
            if (mainClockEl) mainClockEl.innerHTML = mainF || '<span style="color:var(--accent-red)">LIVE NOW</span>';
            if (prelimClockEl) prelimClockEl.innerHTML = prelimF || '<span style="color:var(--accent-red)">LIVE NOW</span>';
        }

        function fmt(date, tz) {
            const opts = { hour: 'numeric', minute: '2-digit', hour12: true };
            if (tz) opts.timeZone = tz;
            return date.toLocaleTimeString('en-US', opts);
        }
        function fmtDate(date, tz) {
            const opts = { weekday: 'short', month: 'short', day: 'numeric' };
            if (tz) opts.timeZone = tz;
            return date.toLocaleDateString('en-US', opts);
        }

        function renderTimes(tz) {
            if (mainTimeEl) mainTimeEl.textContent = fmt(mainDate, tz);
            if (prelimTimeEl) prelimTimeEl.textContent = fmt(prelimDate, tz);
            if (metaDateEl) metaDateEl.textContent = fmtDate(mainDate, tz);
        }

        // ── Timezone switcher (mirrors homepage behavior) ──
        const zoneButtons = document.querySelectorAll('.zone-btn');
        function setActiveZone(tz) {
            zoneButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tz === tz));
            renderTimes(tz);
            try { localStorage.setItem('ww-tz', tz); } catch (e) {}
        }
        zoneButtons.forEach(btn => {
            btn.addEventListener('click', () => setActiveZone(btn.dataset.tz));
        });

        try {
            let savedTz = null;
            try { savedTz = localStorage.getItem('ww-tz'); } catch (e) {}
            if (savedTz && document.querySelector(\`.zone-btn[data-tz="\${savedTz}"]\`)) {
                setActiveZone(savedTz);
            } else {
                renderTimes(null); // browser's local timezone
            }
        } catch (e) {
            renderTimes(null);
        }

        tick();
        setInterval(tick, 1000);
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
