// The sky over Woolsthorpe at Newton's birth, for the vault's openings.
//   cd web && node tools/birth_sky.mjs path/to/hygdata_v41.csv
// The date is 25 Dec 1642 in the Julian calendar then used in England, 4 Jan 1643 Gregorian.
// No reliable source records the hour, so 2 a.m. local time is an assumption.
import { readFileSync, writeFileSync } from 'node:fs';
import * as A from 'astronomy-engine';

const LON = -0.63, LAT = 52.79, MAG = 5.6;
const time = A.MakeTime(new Date(Date.UTC(1643, 0, 4, 2, 0, 0) - (LON / 15) * 3600e3));
const observer = new A.Observer(LAT, LON, 130);
const rotation = A.Rotation_EQJ_HOR(time, observer);
const years = 1643 - 2000;
const place = (x) => { const r = A.RotateVector(rotation, new A.Vector(x[0], x[1], x[2], time)); return [+(-r.y).toFixed(5), +r.x.toFixed(5), +r.z.toFixed(5)]; };   // east, north, up

const [head, ...rows] = readFileSync(process.argv[2], 'utf8').split('\n');
const col = Object.fromEntries(head.split(',').map((k, i) => [k.replaceAll('"', ''), i]));
const stars = [];
for (const row of rows) {
  const f = row.split(',');
  const mag = +f[col.mag];
  if (!row || !(mag <= MAG) || f[col.proper]?.replaceAll('"', '') === 'Sol') continue;
  const dec = +f[col.dec] + (+f[col.pmdec] * years) / 3.6e6;          // proper motion back to 1643
  const ra = +f[col.ra] * 15 + (+f[col.pmra] * years) / 3.6e6 / Math.cos((+f[col.dec] * Math.PI) / 180);
  const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  const v = place([Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]);
  if (v[2] > 0.03) stars.push({ d: v, mag, name: f[col.proper]?.replaceAll('"', '') || undefined });
}
const bodies = [];
for (const body of ['Moon', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Mercury']) {
  const eq = A.Equator(A.Body[body], time, observer, true, true);
  const h = A.Horizon(time, observer, eq.ra, eq.dec, null);
  const alt = (h.altitude * Math.PI) / 180, az = (h.azimuth * Math.PI) / 180;
  bodies.push({ name: body, alt: +h.altitude.toFixed(1), az: +h.azimuth.toFixed(1), mag: +A.Illumination(A.Body[body], time).mag.toFixed(1),
                d: [+(Math.cos(alt) * Math.sin(az)).toFixed(5), +(Math.cos(alt) * Math.cos(az)).toFixed(5), +Math.sin(alt).toFixed(5)] });
}
writeFileSync('../docs/birth_sky.json', JSON.stringify({ when: '1643-01-04 02:00 local (25 Dec 1642 Julian)', where: 'Woolsthorpe, Lincolnshire', stars, bodies }));
const named = stars.filter((s) => s.name && s.mag < 1.6).sort((a, b) => a.mag - b.mag).map((s) => `${s.name} ${(Math.asin(s.d[2]) * 57.3).toFixed(0)}°`);
console.log('stars above horizon', stars.length, 'of', rows.length);
console.log(named.join(', '));
console.log(bodies.map((b) => `${b.name} alt ${b.alt} az ${b.az}`).join('\n'));
