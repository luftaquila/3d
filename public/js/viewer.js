import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadStlWasm } from './stl-wasm.js';

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatMm(v) {
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 10) return v.toFixed(1);
  return Math.round(v).toString();
}
function formatDims(bbox) {
  const w = bbox[3] - bbox[0];
  const d = bbox[4] - bbox[1];
  const h = bbox[5] - bbox[2];
  return `${formatMm(w)} × ${formatMm(d)} × ${formatMm(h)} mm`;
}
function formatCm3(mm3) {
  const cm3 = (mm3 || 0) / 1000;
  if (cm3 < 1) return cm3.toFixed(2);
  if (cm3 < 100) return cm3.toFixed(1);
  return Math.round(cm3).toLocaleString();
}

async function parseWithWasm(buffer) {
  const mod = await loadStlWasm();
  const bytes = new Uint8Array(buffer);
  return mod.parse_stl(bytes);
}

function createMeshFromWasm(mesh) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(mesh.normals.slice(), 3));
  const mat = new THREE.MeshStandardMaterial({
    color: 0xbcc2cc,
    metalness: 0.1,
    roughness: 0.75,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geom, mat);
}

const EDGE_COLOR_BOUNDARY = 0xff3b30;
const EDGE_COLOR_NON_MANIFOLD = 0x00d4ff;

function createEdgeOverlay(positions, color) {
  if (!positions || positions.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geom, mat);
  lines.renderOrder = 2;
  lines.userData.problemEdge = true;
  return lines;
}

export async function mountViewer(container, items, options = {}) {
  if (container._dispose) {
    try { container._dispose(); } catch {}
    container._dispose = null;
  }
  container.innerHTML = '';
  container.classList.remove('hidden');
  container.classList.add('viewer-area');

  const legend = document.createElement('div');
  legend.className = 'viewer-legend';
  legend.textContent = '로딩 중...';
  container.appendChild(legend);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'viewer-close';
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  closeBtn.title = '닫기';
  closeBtn.setAttribute('aria-label', '닫기');
  closeBtn.addEventListener('click', () => {
    if (container._dispose) {
      try { container._dispose(); } catch {}
      container._dispose = null;
    }
    container.innerHTML = '';
    if (options.onClose) options.onClose();
    else container.classList.add('hidden');
  });
  container.appendChild(closeBtn);

  const width = container.clientWidth || 640;
  const height = container.clientHeight || 480;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  container.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);
  const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
  dir1.position.set(1, 1, 1);
  scene.add(dir1);
  const dir2 = new THREE.DirectionalLight(0xffffff, 0.35);
  dir2.position.set(-1, -0.5, -1);
  scene.add(dir2);

  const group = new THREE.Group();
  scene.add(group);

  const parsed = [];
  for (const item of items) {
    try {
      const mesh = await parseWithWasm(item.buffer);
      parsed.push({ name: item.name, mesh });
    } catch (err) {
      console.warn('stl parse failed', item.name, err);
    }
  }

  if (parsed.length === 0) {
    container.innerHTML = '<p class="error" style="padding:12px;">모델을 파싱할 수 없습니다.</p>';
    return;
  }

  const boundaryOverlays = [];
  const nonManifoldOverlays = [];
  const cols = Math.ceil(Math.sqrt(parsed.length));
  const bounds = parsed.map((p) => {
    const m = createMeshFromWasm(p.mesh);
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    const size = bb.getSize(new THREE.Vector3());
    const center = bb.getCenter(new THREE.Vector3());
    m.position.sub(center);

    const boundary = createEdgeOverlay(p.mesh.boundaryEdgePositions, EDGE_COLOR_BOUNDARY);
    if (boundary) { m.add(boundary); boundaryOverlays.push(boundary); }
    const nonManifold = createEdgeOverlay(p.mesh.nonManifoldEdgePositions, EDGE_COLOR_NON_MANIFOLD);
    if (nonManifold) { m.add(nonManifold); nonManifoldOverlays.push(nonManifold); }

    return { mesh: m, size, center };
  });
  const cell = bounds.reduce((acc, b) => Math.max(acc, b.size.x, b.size.y, b.size.z), 0) * 1.3;

  const total = bounds.length;
  bounds.forEach((b, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    b.mesh.position.x += (col - (cols - 1) / 2) * cell;
    b.mesh.position.z += (row - (Math.ceil(total / cols) - 1) / 2) * cell;
    group.add(b.mesh);
  });

  const groupBox = new THREE.Box3().setFromObject(group);
  const gSize = groupBox.getSize(new THREE.Vector3());
  const gCenter = groupBox.getCenter(new THREE.Vector3());
  const maxDim = Math.max(gSize.x, gSize.y, gSize.z) || 1;
  camera.position.set(gCenter.x + maxDim * 1.5, gCenter.y + maxDim, gCenter.z + maxDim * 1.5);
  camera.lookAt(gCenter);

  let grid = null;
  function buildGrid() {
    if (grid) {
      scene.remove(grid);
      grid.geometry.dispose();
      grid.material.dispose();
    }
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridMain = isLight ? 0xd0d0d5 : 0x3a3535;
    const gridSub = isLight ? 0xe5e5ea : 0x2a2525;
    grid = new THREE.GridHelper(maxDim * 3, 20, gridMain, gridSub);
    grid.position.y = -maxDim * 0.6 + gCenter.y;
    scene.add(grid);
  }
  function applyThemeBg() {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#201d1d';
    scene.background = new THREE.Color(bg);
  }
  buildGrid();
  applyThemeBg();
  const themeObserver = new MutationObserver(() => {
    applyThemeBg();
    buildGrid();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(gCenter);
  controls.update();

  const totalTris = parsed.reduce((acc, p) => acc + p.mesh.triangleCount, 0);
  const totalVolume = parsed.reduce((acc, p) => acc + (p.mesh.volume || 0), 0);
  const nonWatertightCount = parsed.filter((p) => p.mesh.isWatertight === false).length;

  const statsParts = [];
  if (parsed.length === 1) {
    const m = parsed[0].mesh;
    statsParts.push(`<div class="legend-dims">${escapeAttr(formatDims(m.bbox))}</div>`);
    const volStr = formatCm3(m.volume || 0);
    const volPrefix = m.isWatertight === false ? '~' : '';
    statsParts.push(`<div class="legend-meta">${volPrefix}${volStr} cm³ · ${totalTris.toLocaleString()} triangles</div>`);
  } else {
    const volPrefix = nonWatertightCount > 0 ? '~' : '';
    statsParts.push(`<div class="legend-meta">${parsed.length} models · ${volPrefix}${formatCm3(totalVolume)} cm³ · ${totalTris.toLocaleString()} triangles</div>`);
  }

  let totalBoundary = 0;
  let totalNonManifold = 0;
  for (const p of parsed) {
    if (p.mesh.isWatertight === false) {
      totalBoundary += p.mesh.boundaryEdges || 0;
      totalNonManifold += p.mesh.nonManifoldEdges || 0;
    }
  }

  const warnParts = [];
  if (parsed.length === 1 && parsed[0].mesh.isWatertight === false) {
    warnParts.push(`<span>Not watertight</span>`);
  } else if (parsed.length > 1 && nonWatertightCount > 0) {
    warnParts.push(`<span>${nonWatertightCount} model${nonWatertightCount === 1 ? '' : 's'} not watertight</span>`);
  }
  if (totalBoundary > 0) {
    warnParts.push(`<button type="button" class="viewer-edge-pill boundary" aria-pressed="true" aria-label="Toggle open edges on model">${totalBoundary.toLocaleString()} open edge${totalBoundary === 1 ? '' : 's'}</button>`);
  }
  if (totalNonManifold > 0) {
    warnParts.push(`<button type="button" class="viewer-edge-pill nonmanifold" aria-pressed="true" aria-label="Toggle non-manifold edges on model">${totalNonManifold.toLocaleString()} non-manifold edge${totalNonManifold === 1 ? '' : 's'}</button>`);
  }
  if (totalBoundary > 0 || totalNonManifold > 0) {
    warnParts.push(`
      <div class="viewer-edge-help">
        <button type="button" class="viewer-edge-help-btn" aria-label="모서리 설명">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>
          <span>도움말</span>
        </button>
        <div class="viewer-edge-help-popover" role="tooltip">
          <div class="viewer-edge-help-row">
            <span class="dot boundary"></span>
            <div>
              <strong>열린 모서리 (open edge)</strong>
              삼각형 하나에만 맞닿는 모서리입니다. 모델에 구멍이 있다는 뜻이며, 슬라이서가 안과 밖을 구분하지 못해 빈틈이 생길 수 있습니다.
            </div>
          </div>
          <div class="viewer-edge-help-row">
            <span class="dot nonmanifold"></span>
            <div>
              <strong>비매니폴드 모서리 (non-manifold edge)</strong>
              세 개 이상의 면이 만나는 모서리입니다. 위상이 모호해서 슬라이서가 일부 영역을 누락하거나 표면 법선이 반전될 수 있습니다.
            </div>
          </div>
        </div>
      </div>
    `);
  }

  const warnHtml = warnParts.length
    ? `<div class="viewer-legend-warn">${warnParts.join('')}</div>`
    : '';
  legend.innerHTML = `${statsParts.join('')}${warnHtml}`;

  function wireEdgePill(selector, overlays) {
    const btn = legend.querySelector(selector);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      const next = !pressed;
      btn.setAttribute('aria-pressed', next ? 'true' : 'false');
      for (const obj of overlays) obj.visible = next;
    });
  }
  wireEdgePill('.viewer-edge-pill.boundary', boundaryOverlays);
  wireEdgePill('.viewer-edge-pill.nonmanifold', nonManifoldOverlays);

  const helpWrap = legend.querySelector('.viewer-edge-help');
  if (helpWrap) {
    const helpBtn = helpWrap.querySelector('.viewer-edge-help-btn');
    helpBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      helpWrap.classList.toggle('pinned');
    });
    helpWrap.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', closeHelpPopover);
  }
  function closeHelpPopover() { helpWrap?.classList.remove('pinned'); }

  let stopped = false;
  function loop() {
    if (stopped) return;
    controls.update();
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

  container._dispose = () => {
    stopped = true;
    ro.disconnect();
    themeObserver.disconnect();
    controls.dispose();
    renderer.dispose();
    document.removeEventListener('click', closeHelpPopover);
    if (grid) { grid.geometry.dispose(); grid.material.dispose(); }
    for (const obj of [...boundaryOverlays, ...nonManifoldOverlays]) {
      obj.geometry.dispose();
      obj.material.dispose();
    }
    bounds.forEach((b) => {
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
    });
  };
}

export function openViewerModal() {
  closeViewerModal();
  const modal = document.createElement('div');
  modal.className = 'viewer-modal';
  modal.id = 'viewer-modal';
  const content = document.createElement('div');
  content.className = 'viewer-modal-content';
  modal.appendChild(content);
  document.body.appendChild(modal);

  function close() {
    if (content._dispose) { try { content._dispose(); } catch {} content._dispose = null; }
    content.innerHTML = '';
    modal.remove();
    document.removeEventListener('keydown', escHandler);
  }
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  function escHandler(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', escHandler);

  return { host: content, close };
}

export function closeViewerModal() {
  const existing = document.getElementById('viewer-modal');
  if (!existing) return;
  const content = existing.querySelector('.viewer-modal-content');
  if (content?._dispose) { try { content._dispose(); } catch {} }
  existing.remove();
}
