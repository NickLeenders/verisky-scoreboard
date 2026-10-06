/** Offline guards for the model-map binary contract and geographic edge cases. */
import assert from 'node:assert/strict';
import { NX, NY, decodeGrid, mapSelection, cellAt, visibleShares, scoreLink, escapeHtml } from '../js/map-data.js';
const prelude = { version: 1, cells: NX * NY, roster: ['ecmwf_ifs', 'gfs_seamless'], contested: 254, noData: 255 };
const head = Buffer.from(JSON.stringify(prelude));
const body = Buffer.alloc(4 + head.length + NX * NY, 255);
body.writeUInt32LE(head.length); head.copy(body, 4);
const grid = decodeGrid(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
assert.equal(grid.plane.length, NX * NY);
assert.throws(() => decodeGrid(new ArrayBuffer(3)), /Incomplete/);
assert.throws(() => decodeGrid(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength - 1)), /Incomplete/);
assert.deepEqual(cellAt(0, 180), { lat: 0, lon: -180 });
assert.deepEqual(cellAt(0, 540), { lat: 0, lon: -180 });
assert.equal(cellAt(100, 0).lat, 90);
const origin = mapSelection(new URLSearchParams('lat=0&lon=0&window=90&metric=sun'));
assert.equal(origin.lat, 0); assert.equal(origin.lon, 0); assert.equal(origin.window, 90); assert.equal(origin.metric, 'sun');
const invalid = mapSelection(new URLSearchParams('lat=bad&lon=500&window=42&metric=nope'));
assert.equal(invalid.lat, 35); assert.equal(invalid.lon, 8); assert.equal(invalid.window, 30); assert.equal(invalid.metric, 'combined');
// A viewport straddling the date line: one model, one tie, one other model.
grid.plane[360 * NX + 1439] = 0; grid.plane[360 * NX] = 254; grid.plane[360 * NX + 1] = 1;
const shares = visibleShares(grid, { south: 0, north: 0, west: 179.75, east: 180.25 });
assert.equal(shares.total, 3);
assert.ok(Math.abs(shares.tieShare - 100 / 3) < 1e-9);
assert.ok(Math.abs(shares.shares.reduce((n, r) => n + r.share, shares.tieShare) - 100) < 1e-9);
assert.equal(scoreLink({ icao: 'EHAM' }), './?city=amsterdam&site=airport');
assert.equal(scoreLink({ icao: 'UNKNOWN' }), null);
assert.equal(escapeHtml('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;');
console.log('Map checks passed (binary framing, selectors, date line, visible shares, links).');
