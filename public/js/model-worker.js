// Parses and analyzes a model off the main thread (module worker), so even a
// several-hundred-MB 3MF only takes time, never freezes the page.
//
// STL goes straight to the WASM parser. A 3MF is unzipped and its *.model XML
// streamed through a small tag scanner (vertices / triangles / components /
// build items) instead of DOMParser, so the XML is never held as one string;
// the build is then baked into a triangle soup for the WASM analyzer.
//
// In: { source: ArrayBuffer | Blob, name, thumb?: size }. While working it posts
// { progress: 0..1, phase }. Out: { ok, mesh } with
// plain typed arrays (transferred), { ok, dataUrl, stats } when a thumbnail was
// asked for and WebGL works in this worker, or { ok: false, error }.
import { loadStlWasm } from './stl-wasm.js';
import { renderThumbnail, meshStats } from './thumb-render.js';

// Workers don't see the page's import map; same URL as index.html.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js';

// Same cap as the WASM analyzer (wasm-src MAX_TRIANGLES); checked while
// scanning so a huge model stops early instead of after the whole parse.
const MAX_TRIANGLES = 5_000_000;

class TooManyTriangles extends Error {}

class Grow {
  constructor(Type, n = 1024) { this.a = new Type(n); this.n = 0; }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) {
      const b = new this.a.constructor(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x; this.a[this.n++] = y; this.a[this.n++] = z;
  }
}

// ── zip (central directory + streamed inflate) ─────────────────────────────
function zipEntries(buf) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('3MF(zip) 형식이 아닙니다.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('3MF 파일이 손상되었습니다.');
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    out.push({ name, method, compSize, local });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}

function entryTextStream(buf, e, onBytes) {
  const dv = new DataView(buf);
  if (dv.getUint32(e.local, true) !== 0x04034b50) throw new Error('3MF 파일이 손상되었습니다.');
  const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
  let stream = new Blob([new Uint8Array(buf, start, e.compSize)]).stream()
    .pipeThrough(new TransformStream({ transform(chunk, c) { onBytes(chunk.byteLength); c.enqueue(chunk); } }));
  if (e.method === 8) stream = stream.pipeThrough(new DecompressionStream('deflate-raw'));
  else if (e.method !== 0) throw new Error(`지원하지 않는 압축 방식(${e.method})입니다.`);
  return stream.pipeThrough(new TextDecoderStream());
}

// ── 3MF model XML ────────────────────────────────────────────────────────────
function attr(tag, name) {
  for (const q of ['"', "'"]) {
    const key = ` ${name}=${q}`;
    let i = tag.indexOf(key);
    if (i < 0) {
      // the first attribute may follow a newline/tab instead of a space
      const m = new RegExp(`\\s${name.replace(':', '\\:')}=${q}`).exec(tag);
      if (!m) continue;
      i = m.index;
    }
    const s = i + key.length;
    return tag.slice(s, tag.indexOf(q, s));
  }
  return null;
}

// 3MF transforms are 4x3, row-vector convention: p' = [x y z 1] * M.
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
function parseTransform(s) {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}
// apply a, then b
function compose(a, b) {
  const r = new Array(12);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      let s = row === 3 ? b[9 + col] : 0;
      for (let k = 0; k < 3; k++) s += a[row * 3 + k] * b[k * 3 + col];
      r[row * 3 + col] = s;
    }
  }
  return r;
}

const normPath = (p) => String(p || '').replace(/^\/+/, '').toLowerCase();
// production-extension path; the namespace prefix is usually "p" but not fixed
const pathAttr = (t) => attr(t, 'p:path') ?? /\s[\w.-]+:path=["']([^"']*)/.exec(t)?.[1] ?? null;

let rawTriangles = 0;

// Progress to the page: 0..1 with a phase. Measured on a 73MB 3MF, reading the
// XML and the WASM topology analysis take about the same time, so a 3MF gets
// 0-0.5 by compressed bytes read and 0.52-0.9 from the analyzer's own
// callback; the (simplified) thumbnail takes the rest.
let lastSent = -1;
function progress(value, phase) {
  const v = Math.min(1, Math.max(0, value));
  if (v - lastSent < 0.01 && v < 1) return;
  lastSent = v;
  self.postMessage({ progress: v, phase });
}

async function scanModel(stream, path, model) {
  const reader = stream.getReader();
  let buf = '';
  let obj = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i = 0;
    for (;;) {
      const lt = buf.indexOf('<', i);
      if (lt < 0) { i = buf.length; break; }
      const gt = buf.indexOf('>', lt);
      if (gt < 0) { i = lt; break; }
      const c = buf.charCodeAt(lt + 1);
      // fast paths for the millions of vertex / triangle tags
      if (c === 118 /* v */ && buf.startsWith('vertex', lt + 1) && obj) {
        const t = buf.slice(lt, gt);
        obj.v.push3(+attr(t, 'x'), +attr(t, 'y'), +attr(t, 'z'));
      } else if (c === 116 /* t */ && buf.startsWith('triangle ', lt + 1) && obj) {
        const t = buf.slice(lt, gt);
        obj.t.push3(+attr(t, 'v1'), +attr(t, 'v2'), +attr(t, 'v3'));
        if (++rawTriangles > MAX_TRIANGLES) throw new TooManyTriangles();
      } else if (c === 111 /* o */ && buf.startsWith('object', lt + 1) && /\s/.test(buf[lt + 7])) {
        const t = buf.slice(lt, gt);
        obj = { v: new Grow(Float32Array), t: new Grow(Uint32Array), comps: [] };
        model.objects.set(attr(t, 'id'), obj);
      } else if (c === 47 /* / */ && buf.startsWith('/object', lt + 1)) {
        obj = null;
      } else if (c === 99 /* c */ && buf.startsWith('component ', lt + 1) && obj) {
        const t = buf.slice(lt, gt);
        obj.comps.push({ id: attr(t, 'objectid'), path: normPath(pathAttr(t)) || path, m: parseTransform(attr(t, 'transform')) });
      } else if (c === 105 /* i */ && buf.startsWith('item ', lt + 1)) {
        const t = buf.slice(lt, gt);
        model.items.push({ id: attr(t, 'objectid'), path: normPath(pathAttr(t)) || path, m: parseTransform(attr(t, 'transform')) });
      }
      i = gt + 1;
    }
    buf = buf.slice(i);
  }
}

async function read3mfPositions(buffer, t = {}) {
  rawTriangles = 0;
  const models = new Map(); // path -> { objects: Map(id -> obj), items: [] }
  const items = [];
  const parts = zipEntries(buffer).filter((e) => /\.model$/i.test(e.name));
  const totalBytes = parts.reduce((n, e) => n + e.compSize, 0) || 1;
  let readBytes = 0;
  const onBytes = (n) => { readBytes += n; progress(0.5 * readBytes / totalBytes, 'parse'); };
  for (const e of parts) {
    const path = normPath(e.name);
    const model = { objects: new Map(), items: [] };
    models.set(path, model);
    await scanModel(entryTextStream(buffer, e, onBytes), path, model);
    items.push(...model.items);
  }
  if (!models.size) throw new Error('3MF에 모델 파일이 없습니다.');
  t.scanned = performance.now();

  const lookup = (path, id) => models.get(path)?.objects.get(id);
  // no <build>: show every mesh object as is
  const roots = items.length ? items : [...models].flatMap(([path, m]) =>
    [...m.objects].filter(([, o]) => o.t.n).map(([id]) => ({ id, path, m: IDENTITY })));

  // count first, then bake into one preallocated soup
  const count = (o, depth) => {
    if (!o || depth > 16) return 0;
    let n = o.t.n / 3;
    for (const c of o.comps) n += count(lookup(c.path, c.id), depth + 1);
    return n;
  };
  const total = roots.reduce((n, r) => n + count(lookup(r.path, r.id), 0), 0);
  if (total > MAX_TRIANGLES) throw new TooManyTriangles();
  if (total === 0) throw new Error('3MF에 미리보기할 메쉬 지오메트리가 없습니다.');

  const out = new Float32Array(total * 9);
  let w = 0;
  const bake = (o, m, depth) => {
    if (!o || depth > 16) return;
    const v = o.v.a;
    const t = o.t.a;
    for (let k = 0; k < o.t.n; k++) {
      const b = t[k] * 3;
      const x = v[b], y = v[b + 1], z = v[b + 2];
      out[w++] = x * m[0] + y * m[3] + z * m[6] + m[9];
      out[w++] = x * m[1] + y * m[4] + z * m[7] + m[10];
      out[w++] = x * m[2] + y * m[5] + z * m[8] + m[11];
    }
    for (const c of o.comps) bake(lookup(c.path, c.id), compose(c.m, m), depth + 1);
  };
  for (const r of roots) bake(lookup(r.path, r.id), r.m, 0);
  return out;
}

function timings(t) {
  const r = {};
  let prev = t.start;
  for (const k of ['scanned', 'baked', 'analyzed', 'thumb']) {
    if (t[k] != null) { r[k] = Math.round(t[k] - prev); prev = t[k]; }
  }
  return r;
}

function plain(mesh) {
  return {
    positions: mesh.positions,
    normals: mesh.normals,
    triangleCount: mesh.triangleCount,
    bbox: mesh.bbox,
    isWatertight: mesh.isWatertight,
    boundaryEdges: mesh.boundaryEdges,
    nonManifoldEdges: mesh.nonManifoldEdges,
    degenerateTriangles: mesh.degenerateTriangles,
    boundaryEdgePositions: mesh.boundaryEdgePositions,
    nonManifoldEdgePositions: mesh.nonManifoldEdgePositions,
    volume: mesh.volume,
    surfaceArea: mesh.surfaceArea,
  };
}

// Thumbnail rendered here when OffscreenCanvas has WebGL; null otherwise (the
// page then renders it).
async function workerThumbnail(mesh, size) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  try {
    if (!new OffscreenCanvas(1, 1).getContext('webgl2')) return null;
    const THREE = await import(THREE_URL);
    const canvas = renderThumbnail(THREE, mesh, size, (w, h) => new OffscreenCanvas(w, h),
      (f) => progress(0.9 + 0.1 * f, 'thumbnail'));
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new FileReaderSync().readAsDataURL(blob);
  } catch {
    return null;
  }
}

self.onmessage = async ({ data }) => {
  try {
    const t = { start: performance.now() };
    progress(0, 'read');
    const buffer = data.source instanceof Blob ? await data.source.arrayBuffer() : data.source;
    const mod = await loadStlWasm();
    let wasmMesh;
    if (/\.3mf$/i.test(data.name || '')) {
      const positions = await read3mfPositions(buffer, t);
      t.baked = performance.now();
      progress(0.52, 'analyze');
      wasmMesh = mod.analyze_positions(positions, (f) => progress(0.52 + 0.38 * f, 'analyze'));
    } else {
      progress(0.05, 'analyze');
      wasmMesh = mod.parse_stl(new Uint8Array(buffer), (f) => progress(0.05 + 0.85 * f, 'analyze'));
    }
    const mesh = plain(wasmMesh);
    wasmMesh.free?.();
    t.analyzed = performance.now();
    if (data.thumb) {
      progress(0.9, 'thumbnail');
      const dataUrl = await workerThumbnail(mesh, data.thumb);
      t.thumb = performance.now();
      if (dataUrl) {
        self.postMessage({ ok: true, dataUrl, stats: meshStats(mesh), timings: timings(t) });
        return;
      }
    }
    const transfer = Object.values(mesh).filter((v) => ArrayBuffer.isView(v)).map((v) => v.buffer);
    self.postMessage({ ok: true, mesh }, transfer);
  } catch (err) {
    const tooMany = err instanceof TooManyTriangles || /triangle count exceeds limit/.test(String(err));
    self.postMessage({
      ok: false,
      tooLarge: tooMany,
      error: tooMany
        ? `삼각형이 너무 많아(${MAX_TRIANGLES.toLocaleString('ko-KR')}개 초과) 브라우저 미리보기를 생략합니다.`
        : String(err?.message || err),
    });
  }
};
