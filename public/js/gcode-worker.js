// Web Worker: Bambu Studio G-code -> per-feature line segments by layer.
//
// In:  { text }   (one plate's G-code)
// Out: { features: [{ name, positions: Float32Array (x,y,z × 2 per segment),
//                     layerStart: Uint32Array (segment index where each layer starts, +1 end) }],
//        layers: [{ z, timeS }], totalTimeS }
//
// Bambu specifics: layers start at "; CHANGE_LAYER" followed by "; Z_HEIGHT: z",
// extrusion roles come from "; FEATURE: <name>", E is relative (M83), and
// arc fitting emits G2/G3 with I/J centre offsets. Everything before the first
// layer (start G-code, purge line) is skipped; travel moves become "Travel".

const ARC_STEP_RAD = Math.PI / 18; // 10° per chord

class Growable {
  constructor() { this.buf = new Float32Array(1 << 14); this.len = 0; }
  push6(a, b, c, d, e, f) {
    if (this.len + 6 > this.buf.length) {
      const next = new Float32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    const o = this.len;
    const B = this.buf;
    B[o] = a; B[o + 1] = b; B[o + 2] = c; B[o + 3] = d; B[o + 4] = e; B[o + 5] = f;
    this.len += 6;
  }
  done() { return this.buf.slice(0, this.len); }
}

function parse(text) {
  const features = new Map(); // name -> { seg: Growable, layerStart: number[] }
  const layers = [];
  let layer = -1;
  let feature = 'Custom';
  let x = 0, y = 0, z = 0;
  let absXYZ = true;
  let absE = false;
  let lastRemainMin = null;
  let feed = 3000; // mm/min
  let firstRemainMin = null;

  const featureOf = (name) => {
    let f = features.get(name);
    if (!f) {
      f = { seg: new Growable(), layerStart: [] };
      features.set(name, f);
    }
    // pad layer starts up to the current layer
    while (f.layerStart.length <= layer) f.layerStart.push(f.seg.len / 6);
    return f;
  };

  const addSeg = (name, x0, y0, z0, x1, y1, z1) => {
    if (layer < 0) return;
    featureOf(name).seg.push6(x0, y0, z0, x1, y1, z1);
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = n;
    const line = text.slice(i, j);
    i = j + 1;
    if (!line) continue;

    if (line.charCodeAt(0) === 59 /* ; */) {
      if (line.startsWith('; CHANGE_LAYER')) {
        layer += 1;
        layers.push({ z, timeS: 0, rawS: 0 });
        if (firstRemainMin == null) firstRemainMin = lastRemainMin;
      } else if (line.startsWith('; Z_HEIGHT:') && layer >= 0) {
        layers[layer].z = parseFloat(line.slice(11));
      } else if (line.startsWith('; FEATURE:')) {
        feature = line.slice(10).trim();
      }
      continue;
    }

    const sc = line.indexOf(';');
    const code = (sc >= 0 ? line.slice(0, sc) : line).trim();
    if (!code) continue;
    const parts = code.split(/\s+/);
    const cmd = parts[0];

    if (cmd === 'G90') { absXYZ = true; continue; }
    if (cmd === 'G91') { absXYZ = false; continue; }
    if (cmd === 'M82') { absE = true; continue; }
    if (cmd === 'M83') { absE = false; continue; }
    if (cmd === 'M73') {
      for (const p of parts) if (p[0] === 'R') lastRemainMin = parseFloat(p.slice(1));
      continue;
    }
    const isMove = cmd === 'G0' || cmd === 'G1';
    const isArc = cmd === 'G2' || cmd === 'G3';
    if (!isMove && !isArc) continue;

    let nx = x, ny = y, nz = z, e = 0, I = 0, J = 0;
    let hasXY = false;
    for (let k = 1; k < parts.length; k++) {
      const p = parts[k];
      const v = parseFloat(p.slice(1));
      if (Number.isNaN(v)) continue;
      switch (p[0]) {
        case 'X': nx = absXYZ ? v : x + v; hasXY = true; break;
        case 'Y': ny = absXYZ ? v : y + v; hasXY = true; break;
        case 'Z': nz = absXYZ ? v : z + v; break;
        case 'E': e = v; break;
        case 'I': I = v; break;
        case 'J': J = v; break;
        case 'F': if (v > 0) feed = v; break;
        default: break;
      }
    }
    // Bambu emits M83 (relative E). Under M82 a positive E still marks an
    // extruding move for preview purposes; exact amounts don't matter here.
    const role = e > 0 ? feature : 'Travel';

    if (isArc && hasXY) {
      const cx = x + I, cy = y + J;
      const r = Math.hypot(x - cx, y - cy);
      let a0 = Math.atan2(y - cy, x - cx);
      let a1 = Math.atan2(ny - cy, nx - cx);
      const cw = cmd === 'G2';
      let sweep = a1 - a0;
      if (cw && sweep >= 0) sweep -= 2 * Math.PI;
      if (!cw && sweep <= 0) sweep += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD));
      let px = x, py = y, pz = z;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const a = a0 + sweep * t;
        const qx = s === steps ? nx : cx + r * Math.cos(a);
        const qy = s === steps ? ny : cy + r * Math.sin(a);
        const qz = z + (nz - z) * t;
        addSeg(role, px, py, pz, qx, qy, qz);
        if (layer >= 0) layers[layer].rawS += Math.hypot(qx - px, qy - py, qz - pz) / feed * 60;
        px = qx; py = qy; pz = qz;
      }
    } else if (hasXY && (nx !== x || ny !== y)) {
      addSeg(role, x, y, z, nx, ny, nz);
      if (layer >= 0) layers[layer].rawS += Math.hypot(nx - x, ny - y, nz - z) / feed * 60;
    }
    x = nx; y = ny; z = nz;
  }

  // Per-layer time: distance/feedrate (no acceleration) gives each layer's
  // share; scale the shares to the slicer's own total from M73 R (minutes),
  // which only has minute resolution and can't be split per layer itself.
  const rawTotal = layers.reduce((a, l) => a + l.rawS, 0) || 1;
  const totalTimeS = firstRemainMin != null ? firstRemainMin * 60 : rawTotal;
  for (const l of layers) l.timeS = (l.rawS / rawTotal) * totalTimeS;

  const out = [];
  for (const [name, f] of features) {
    while (f.layerStart.length <= layers.length) f.layerStart.push(f.seg.len / 6);
    out.push({ name, positions: f.seg.done(), layerStart: Uint32Array.from(f.layerStart) });
  }
  return { features: out, layers: layers.map((l) => ({ z: l.z, timeS: l.timeS })), totalTimeS };
}

self.onmessage = (ev) => {
  try {
    const res = parse(ev.data.text);
    const transfer = [];
    for (const f of res.features) transfer.push(f.positions.buffer, f.layerStart.buffer);
    self.postMessage({ ok: true, ...res }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
