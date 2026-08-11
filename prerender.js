const https = require('https');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

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

async function main() {
  try {
    console.log('Fetching UFC...');
    const ufc = await fetchCSV(UFC_CSV);
    const ufcRows = parse(ufc, { skip_empty_lines: true });
    ufcRows.shift();

    console.log('Fetching Boxing...');
    const boxing = await fetchCSV(BOXING_CSV);
    const boxingRows = parse(boxing, { skip_empty_lines: true });
    boxingRows.shift();

    const fights = [];
    for (const row of ufcRows) {
      if (row[0] && row[1] && row[10] && row[14]) {
        fights.push({ event: row[1], fighter_a: row[10], fighter_b: row[14], date: row[3], sport: 'MMA' });
      }
    }
    for (const row of boxingRows) {
      if (row[0] && row[1] && row[10] && row[14]) {
        fights.push({ event: row[1], fighter_a: row[10], fighter_b: row[14], date: row[3], sport: 'BOXING' });
      }
    }

    fs.writeFileSync('fights.json', JSON.stringify(fights.sort((a,b) => new Date(a.date) - new Date(b.date)), null, 2));
    console.log(`✓ Generated fights.json (${fights.length} fights)`);
  } catch (error) {
    console.error('❌ Failed:', error.message);
    process.exit(1);
  }
}

main();
