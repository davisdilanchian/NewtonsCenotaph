// The sky over Woolsthorpe at Newton's birth, for the vault's openings and the figures painted round them.
//   cd web && node tools/birth_sky.mjs path/to/hygdata_v41.csv path/to/d3-celestial/data
// The date is 25 Dec 1642 in the Julian calendar then used in England, 4 Jan 1643 Gregorian.
// No reliable source records the hour, so 2 a.m. local time is an assumption.
// The figures are Ptolemy's 48, the constellations Newton knew, drawn with the stick figures of
// d3-celestial (BSD-3-Clause, Olaf Frohn): constellations.lines.json and constellations.json.
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
const stars = [], catalogue = [];
const unit = (ra, dec) => { const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; };
for (const row of rows) {
  const f = row.split(',');
  const mag = +f[col.mag];
  if (!row || !(mag <= 7) || f[col.proper]?.replaceAll('"', '') === 'Sol') continue;
  const dec = +f[col.dec] + (+f[col.pmdec] * years) / 3.6e6;          // proper motion back to 1643
  const ra = +f[col.ra] * 15 + (+f[col.pmra] * years) / 3.6e6 / Math.cos((+f[col.dec] * Math.PI) / 180);
  const v = place(unit(ra, dec));
  catalogue.push({ j2000: unit(+f[col.ra] * 15, +f[col.dec]), v });
  if (mag <= MAG && v[2] > 0.03) stars.push({ d: v, mag, name: f[col.proper]?.replaceAll('"', '') || undefined });
}

// Each corner of a figure is a catalogue star, so it is moved back to 1643 like the openings and
// lands exactly on one. A segment that dips below the horizon is cut where it meets it.
const PTOLEMY = 'And Aqr Aql Ara Ari Aur Boo CMa CMi Cnc Cap Car Cas Cen Cep Cet CrA CrB Crv Crt Cyg Del Dra Equ Eri Gem Her Hya Leo Lep Lib Lup Lyr Oph Ori Peg Per Psc PsA Pup Pyx Sge Sgr Sco Ser Tau Tri UMa UMi Vel Vir'.split(' ');
const ARGO = { Pup: 'ARGO NAVIS', Car: '', Vel: '', Pyx: '' };     // the ship was still one figure in Newton's day
const data = process.argv[3];
const figures = JSON.parse(readFileSync(`${data}/constellations.lines.json`, 'utf8')).features;
const names = Object.fromEntries(JSON.parse(readFileSync(`${data}/constellations.json`, 'utf8')).features.map((f) => [f.id, f]));
const snap = ([ra, dec]) => {
  const u = unit(ra, dec);
  let best = null, near = Math.cos((0.2 * Math.PI) / 180);
  for (const s of catalogue) { const c = s.j2000[0] * u[0] + s.j2000[1] * u[1] + s.j2000[2] * u[2]; if (c > near) { near = c; best = s.v; } }
  return best ?? place(u);
};
const slerpUp = (a, b) => {                        // the point on the arc from a (above) to b (below) at the horizon
  let lo = 0, hi = 1, p = a;
  for (let i = 0; i < 30; i++) {
    const t = (lo + hi) / 2, w = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const k0 = Math.sin((1 - t) * w) / Math.sin(w), k1 = Math.sin(t * w) / Math.sin(w);
    p = a.map((x, j) => x * k0 + b[j] * k1);
    if (p[2] > 0) lo = t; else hi = t;
  }
  return p.map((x) => +x.toFixed(5));
};
const constellations = [];
for (const f of figures) {
  if (!PTOLEMY.includes(f.id) || constellations.some((c) => c.id === f.id && f.id !== 'Ser')) continue;
  const segs = [];
  for (const line of f.geometry.coordinates) {
    const pts = line.map(snap);
    for (let i = 1; i < pts.length; i++) {
      let [a, b] = [pts[i - 1], pts[i]];
      if (a[2] <= 0 && b[2] <= 0) continue;
      const ends = [a[2] > 0, b[2] > 0];
      if (!ends[1]) b = slerpUp(a, b); else if (!ends[0]) a = slerpUp(b, a);
      segs.push([a, b, ends]);
    }
  }
  if (!segs.length) continue;
  const label = names[f.id].geometry.coordinates, at = place(unit(label[0], label[1]));
  const name = f.id in ARGO ? ARGO[f.id] : names[f.id].properties.la.toUpperCase().replaceAll('U', 'V').replaceAll('J', 'I');
  constellations.push({ id: f.id, name: at[2] > 0.08 && name ? name : undefined, at, segs });
}
writeFileSync('public/assets/constellations.json', JSON.stringify(constellations));
console.log('constellations above the horizon', constellations.length, 'segments', constellations.reduce((n, c) => n + c.segs.length, 0),
            'named', constellations.filter((c) => c.name).map((c) => c.name).join(', '));
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
