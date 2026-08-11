const https = require('https');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Sheet URLs (export format)
const UFC_CSV = 'https://docs.google.com/spreadsheets/d/1FBQIfCL3c_mHBRrvoq1Z-TdRxv1wgWS62ZRj-BWEOwo/export?format=csv&gid=0';
const BOXING_CSV = 'https://docs.google.com/spreadsheets/d/19pw20qoffcJ9sH4QZW74L8-_WID9mSeTHnThPanWA_M/export?format=csv';

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    const parsed = new Date(dateStr);
    return isNaN(parsed) ? null : parsed.toISOString();
  } catch {
    return null;
  }
}

function normalizeFightData(rows, sport) {
  const fights = [];
  
  for (const row of rows) {
    const eventId = row[0]?.trim();
    const eventName = row[1]?.trim();
    const organization = row[2]?.trim();
    const dateStr = row[3]?.trim();
    const mainTime = row[4]?.trim();
    const prelimTime = row[5]?.trim();
    const timezone = row[6]?.trim();
    const city = row[7]?.trim();
    const country = row[8]?.trim();
    
    const fighterA = row[10]?.trim();
    const fighterB = row[14]?.trim();
    
    if (!eventId || !eventName || !dateStr || !fighterA || !fighterB) continue;
    
    const datetime = parseDate(dateStr);
    if (!datetime) continue;
    
    fights.push({
      id: `${sport}-${eventId}-${fighterA.replace(/\s+/g, '-').toLowerCase()}`,
      eventId: eventId,
      eventName: eventName,
      organization: organization || '',
      datetime: datetime,
      mainTime: mainTime || '',
      prelimTime: prelimTime || '',
      timezone: timezone || 'UTC',
      city: city || '',
      country: country || '',
      sport: sport,
      fighters: {
        a: fighterA,
        b: fighterB
      }
    });
  }
  
  return fights;
}

async function main() {
  try {
    console.log('Fetching UFC sheet...');
    const ufcCSV = await fetchCSV(UFC_CSV);
    const ufcRows = parse(ufcCSV, { skip_empty_lines: true });
    ufcRows.shift();
    const
