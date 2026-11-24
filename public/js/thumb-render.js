// Renders a parsed mesh (positions / normals, Z-up) into a cropped square
// thumbnail canvas. Shared by the main thread and the parse worker, so it takes
// THREE and a canvas factory (HTMLCanvasElement or OffscreenCanvas).
// onStep(fraction) is told when the simplification is done (before the render).
export function renderThumbnail(THREE, mesh, size, newCanvas, onStep) {
  mesh = simplifyForThumbnail(mesh.positions) ?? mesh;
  onStep?.(0.5);
  const scene = new THREE.Scene();
  scene.background = null;

  const geom = new THREE.BufferGeometry();
  // the worker hands over its own arrays (no copy needed)
  geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  // Models are authored Z-up; rotate to the Y-up scene so thumbnails sit upright,
  // matching the viewer. (`name` still selects the parser upstream.)
  geom.rotateX(-Math.PI / 2);
  geom.computeBoundingBox();

  const bb = geom.boundingBox;
  const center = bb.getCenter(new THREE.Vector3());
  const maxDim = Math.max(...bb.getSize(new THREE.Vector3()).toArray()) || 1;

  const material = new THREE.MeshStandardMaterial({
    color: 0xbcc2cc,
    metalness: 0.15,
    roughness: 0.7,
    side: THREE.DoubleSide,
  });
  const meshObj = new THREE.Mesh(geom, material);
  meshObj.position.sub(center);
  scene.add(meshObj);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 1.2, 1);
  scene.add(dir);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-1, -0.5, -1);
  scene.add(fill);

  geom.computeBoundingSphere();
  const radius = geom.boundingSphere.radius || maxDim / 2;
  const fov = 40;
  const dist = radius / Math.sin((fov / 2) * (Math.PI / 180));
  const camera = new THREE.PerspectiveCamera(fov, 1, maxDim * 0.01, maxDim * 100);
  camera.position.set(dist, dist * 0.75, dist);
  camera.lookAt(0, 0, 0);

  const renderSize = Math.round(size * 1.6);
  const canvas = newCanvas(renderSize, renderSize);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
    alpha: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(renderSize, renderSize, false);
  renderer.setPixelRatio(1);
  renderer.render(scene, camera);

  const tmp = newCanvas(renderSize, renderSize);
  const ctx = tmp.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const imgData = ctx.getImageData(0, 0, renderSize, renderSize);
  const px = imgData.data;

  let x0 = renderSize, x1 = 0, y0 = renderSize, y1 = 0;
  for (let y = 0; y < renderSize; y++) {
    for (let x = 0; x < renderSize; x++) {
      if (px[(y * renderSize + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  let out = tmp; // 2D copy: stays valid after the WebGL context is released
  if (x1 >= x0) {
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const contentSize = Math.max(cw, ch);
    const pad = contentSize * 0.08;
    const cropSize = contentSize + pad * 2;
    const ccx = (x0 + x1) / 2;
    const ccy = (y0 + y1) / 2;

    out = newCanvas(size, size);
    const octx = out.getContext('2d');
    octx.drawImage(tmp,
      ccx - cropSize / 2, ccy - cropSize / 2, cropSize, cropSize,
      0, 0, size, size,
    );
  }

  geom.dispose();
  material.dispose();
  renderer.dispose();
  renderer.forceContextLoss?.();
  return out;
}

// A 512px thumbnail can't show millions of triangles, and drawing them all
// took longer than parsing. Above THUMB_MAX_TRIANGLES the vertices are snapped
// to a grid finer than a pixel and triangles that collapse are dropped (vertex
// clustering); flat normals are recomputed. Returns null when not needed.
const THUMB_MAX_TRIANGLES = 300_000;
const THUMB_GRID = 1024; // cells along the longest side

export function simplifyForThumbnail(positions) {
  const n = positions.length / 9;
  if (n <= THUMB_MAX_TRIANGLES) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const cell = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / THUMB_GRID || 1;
  const out = new Float32Array(positions.length);
  const q = new Float32Array(9);
  let w = 0;
  for (let i = 0; i < positions.length; i += 9) {
    for (let k = 0; k < 9; k++) {
      const axis = k % 3;
      q[k] = Math.round((positions[i + k] - min[axis]) / cell) * cell + min[axis];
    }
    const same = (a, b) => q[a] === q[b] && q[a + 1] === q[b + 1] && q[a + 2] === q[b + 2];
    if (same(0, 3) || same(3, 6) || same(0, 6)) continue;
    out.set(q, w);
    w += 9;
  }
  const pos = out.slice(0, w);
  const normals = new Float32Array(w);
  for (let i = 0; i < w; i += 9) {
    const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 9; k += 3) { normals[i + k] = nx; normals[i + k + 1] = ny; normals[i + k + 2] = nz; }
  }
  return { positions: pos, normals };
}

export function meshStats(mesh) {
  return {
    triangleCount: mesh.triangleCount,
    isWatertight: mesh.isWatertight,
    boundaryEdges: mesh.boundaryEdges,
    nonManifoldEdges: mesh.nonManifoldEdges,
    degenerateTriangles: mesh.degenerateTriangles,
    volume: mesh.volume,
    surfaceArea: mesh.surfaceArea,
  };
}
