// Shared three.js scene for the sliced-preview and layout-editor modals:
// a Z-up world in Bambu Lab P1S plate coordinates (mm, origin front-left).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const BED = { x: 256, y: 256, z: 250 };
// bed_exclude_area of the P1S machine preset (front-left corner).
export const EXCLUDE = { x0: 0, y0: 0, x1: 18, y1: 28 };

export function createBedScene(container) {
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1c1c1e);

  const camera = new THREE.PerspectiveCamera(40, width / height, 1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(BED.x / 2, -BED.y * 0.9, BED.z * 1.1);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(BED.x / 2, BED.y / 2, 0);
  controls.update();

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(BED.x, -BED.y, BED.z * 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-BED.x, BED.y * 2, BED.z);
  scene.add(fill);

  const disposables = [];
  const track = (o) => { disposables.push(o); return o; };

  // plate
  const plate = new THREE.Mesh(
    track(new THREE.PlaneGeometry(BED.x, BED.y)),
    track(new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.95 })),
  );
  plate.position.set(BED.x / 2, BED.y / 2, -0.05);
  scene.add(plate);

  // 10 mm grid
  const gridPts = [];
  for (let v = 0; v <= BED.x; v += 10) gridPts.push(v, 0, 0, v, BED.y, 0);
  for (let v = 0; v <= BED.y; v += 10) gridPts.push(0, v, 0, BED.x, v, 0);
  const gridGeom = track(new THREE.BufferGeometry());
  gridGeom.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  scene.add(new THREE.LineSegments(gridGeom, track(new THREE.LineBasicMaterial({ color: 0x45454a }))));

  // excluded corner
  const ex = new THREE.Mesh(
    track(new THREE.PlaneGeometry(EXCLUDE.x1 - EXCLUDE.x0, EXCLUDE.y1 - EXCLUDE.y0)),
    track(new THREE.MeshBasicMaterial({ color: 0xd04040, transparent: true, opacity: 0.45 })),
  );
  ex.position.set((EXCLUDE.x0 + EXCLUDE.x1) / 2, (EXCLUDE.y0 + EXCLUDE.y1) / 2, 0.02);
  scene.add(ex);

  // build volume outline
  const box = track(new THREE.BoxGeometry(BED.x, BED.y, BED.z));
  const edges = new THREE.LineSegments(
    track(new THREE.EdgesGeometry(box)),
    track(new THREE.LineBasicMaterial({ color: 0x5a5a60, transparent: true, opacity: 0.5 })),
  );
  edges.position.set(BED.x / 2, BED.y / 2, BED.z / 2);
  scene.add(edges);

  let stopped = false;
  const beforeRender = [];
  function loop() {
    if (stopped) return;
    controls.update();
    for (const fn of beforeRender) fn();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }
  loop();

  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(container);

  function dispose() {
    stopped = true;
    ro.disconnect();
    controls.dispose();
    for (const d of disposables) d.dispose?.();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return { THREE, scene, camera, renderer, controls, track, beforeRender, dispose };
}
