import * as THREE from 'three';
import { loadStlWasm } from './stl-wasm.js';

export async function generateThumbnail(arrayBuffer, size = 512) {
  const mod = await loadStlWasm();
  const mesh = mod.parse_stl(new Uint8Array(arrayBuffer));

  const scene = new THREE.Scene();
  scene.background = null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(mesh.normals.slice(), 3));
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
  const canvas = document.createElement('canvas');
  canvas.width = renderSize;
  canvas.height = renderSize;
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

  const tmp = document.createElement('canvas');
  tmp.width = renderSize;
  tmp.height = renderSize;
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

  let dataUrl;
  if (x1 >= x0) {
    const cw = x1 - x0 + 1;
    const ch = y1 - y0 + 1;
    const contentSize = Math.max(cw, ch);
    const pad = contentSize * 0.08;
    const cropSize = contentSize + pad * 2;
    const ccx = (x0 + x1) / 2;
    const ccy = (y0 + y1) / 2;

    const out = document.createElement('canvas');
    out.width = size;
    out.height = size;
    const octx = out.getContext('2d');
    octx.drawImage(tmp,
      ccx - cropSize / 2, ccy - cropSize / 2, cropSize, cropSize,
      0, 0, size, size,
    );
    dataUrl = out.toDataURL('image/png');
  } else {
    dataUrl = canvas.toDataURL('image/png');
  }

  geom.dispose();
  material.dispose();
  renderer.dispose();
  renderer.forceContextLoss?.();

  return {
    dataUrl,
    triangleCount: mesh.triangleCount,
    isWatertight: mesh.isWatertight,
    boundaryEdges: mesh.boundaryEdges,
    nonManifoldEdges: mesh.nonManifoldEdges,
    degenerateTriangles: mesh.degenerateTriangles,
  };
}
