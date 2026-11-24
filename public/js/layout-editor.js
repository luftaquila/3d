// Plate layout editor for one sliced quote file: per object lay-on-face,
// move (XY) and rotate (Z), or apply one of the explored orientation
// candidates; then re-slice with exactly this placement.
//
// Geometry comes from the worker's decimated previews (object frame); the
// saved matrices map object frame -> plate coordinates (row-major 4x4), which
// is what the slicer worker applies to the full-resolution meshes.
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { createBedScene, BED, EXCLUDE } from './slice-scene.js';

const COLOR_OK = 0xbcc2cc;
const COLOR_SELECTED = 0x7fb2ff;
const COLOR_BAD = 0xe0524a;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function rowMajor(m) {
  const e = m.elements; // column-major
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

// Mounts the editor into the slice detail view. The tools sit on top of the
// 3D view in els.canvas: a toolbar (top left) and a card for the selected
// object and saving (bottom left, or in els.dock on phones); els.status is a
// message line.
// base: '/slices/<q>/<f>'; result: the slice result JSON. onSave(layout) ->
// Promise, called with {arrange, objects:[{index, matrix}]}. Returns { dispose }.
const HINTS = {
  translate: '객체를 눌러 선택하고 화살표를 끌어 옮깁니다.',
  rotate: '객체를 눌러 선택하고 고리를 끌거나 버튼으로 돌립니다.',
  face: '선택한 객체에서 바닥에 닿을 면을 누릅니다.',
};

export function mountLayoutEditor(els, { base, result, onSave }) {
  const objectsInfo = result.objects || [];
  const host = document.createElement('div');
  host.className = 'le-overlays';
  host.innerHTML = `
    <div class="ov ov-tl le-tools">
      <div class="seg">
        <button class="le-mode" data-mode="translate">이동</button>
        <button class="le-mode" data-mode="rotate">회전</button>
        <button class="le-mode" data-mode="face">바닥 면</button>
      </div>
      <div class="seg">
        <button class="le-rot" data-deg="90" title="왼쪽으로 90도">⟲ 90°</button>
        <button class="le-rot" data-deg="15" title="왼쪽으로 15도">⟲ 15°</button>
        <button class="le-rot" data-deg="-15" title="오른쪽으로 15도">⟳ 15°</button>
        <button class="le-rot" data-deg="-90" title="오른쪽으로 90도">⟳ 90°</button>
      </div>
    </div>
    <div class="ov ov-bl le-card small">
      <div class="le-selected"></div>
      <div class="le-problems"></div>
      <label class="le-check"><input type="checkbox" class="le-arrange"> 위치는 슬라이서 자동 배치</label>
      <button class="btn accent le-save">이 배치로 다시 슬라이싱</button>
      <div class="le-hint muted"></div>
    </div>`;
  const card = host.querySelector('.le-card'); // may be docked elsewhere below
  const $ = (sel) => host.querySelector(sel) || card.querySelector(sel);
  const status = els.status;
  status.textContent = '모델 불러오는 중…';
  const view = createBedScene(els.canvas);
  els.canvas.append(host);
  // phones: the object card would cover most of the view; dock it at the top
  // of the info panel instead
  if (els.dock && window.matchMedia('(max-width: 700px)').matches) {
    card.classList.remove('ov', 'ov-bl');
    card.classList.add('le-docked');
    els.dock.append(card);
  }
  const { THREE, scene, camera, renderer, controls } = view;

  const tc = new TransformControls(camera, renderer.domElement);
  tc.setRotationSnap(THREE.MathUtils.degToRad(15));
  if (window.matchMedia('(pointer: coarse)').matches) tc.setSize(1.6); // finger-sized handles
  scene.add(tc.getHelper());
  tc.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });

  const items = []; // { info, group, mesh, problems: [] }
  let selected = null;
  let mode = 'translate';
  const loader = new STLLoader();

  let disposed = false;

  const worldBox = (obj) => new THREE.Box3().setFromObject(obj);

  function dropToBed(it) {
    it.group.updateMatrixWorld(true);
    const b = worldBox(it.mesh);
    it.group.position.z -= b.min.z;
    it.group.updateMatrixWorld(true);
  }

  // rotate in world space about the object's XY centre, then re-seat on the bed
  function rotateWorld(it, q) {
    const before = worldBox(it.mesh).getCenter(new THREE.Vector3());
    it.group.quaternion.premultiply(q);
    it.group.updateMatrixWorld(true);
    const after = worldBox(it.mesh).getCenter(new THREE.Vector3());
    it.group.position.x += before.x - after.x;
    it.group.position.y += before.y - after.y;
    dropToBed(it);
  }

  function validate() {
    const boxes = items.map((it) => worldBox(it.mesh));
    const arrange = $('.le-arrange').checked;
    const lines = [];
    items.forEach((it, i) => {
      const b = boxes[i];
      const p = [];
      if (b.max.z > BED.z) p.push('높이가 250mm를 넘습니다');
      if (!arrange) {
        if (b.min.x < -0.01 || b.min.y < -0.01 || b.max.x > BED.x + 0.01 || b.max.y > BED.y + 0.01) p.push('판 밖으로 나갔습니다');
        if (b.min.x < EXCLUDE.x1 + 1 && b.min.y < EXCLUDE.y1 + 1 && b.max.x > EXCLUDE.x0 && b.max.y > EXCLUDE.y0) {
          p.push('왼쪽 앞 금지 구역과 겹칩니다');
        }
        for (let k = 0; k < i; k++) {
          const o = boxes[k];
          if (b.min.x < o.max.x && b.max.x > o.min.x && b.min.y < o.max.y && b.max.y > o.min.y) {
            p.push(`#${items[k].info.index}와 겹칠 수 있습니다(외곽 기준)`);
          }
        }
      }
      it.problems = p.filter((s) => !s.startsWith('#')); // overlap is only a warning
      it.mesh.material.color.setHex(it === selected ? COLOR_SELECTED : (it.problems.length ? COLOR_BAD : COLOR_OK));
      for (const s of p) lines.push(`#${it.info.index} ${s}`);
    });
    $('.le-problems').innerHTML = lines.length
      ? lines.map((s) => `<div class="${s.includes('겹칠 수') ? 'muted' : 'error'}">${escapeHtml(s)}</div>`).join('')
      : '<div class="muted">배치 문제 없음</div>';
    $('.le-save').disabled = items.some((it) => it.problems.length);
  }

  function renderSelected() {
    const el = $('.le-selected');
    host.querySelectorAll('.le-rot').forEach((b) => { b.disabled = !selected; });
    if (!selected) { el.innerHTML = '<div class="muted">객체를 눌러 선택하세요</div>'; return; }
    const info = selected.info;
    const cands = (info.candidates || []).filter((c) => c.feasible);
    const b = worldBox(selected.mesh);
    el.innerHTML = `
      <div><b>#${info.index}</b> ${escapeHtml(info.name)}</div>
      <div class="muted">${(b.max.x - b.min.x).toFixed(0)} × ${(b.max.y - b.min.y).toFixed(0)} × ${(b.max.z - b.min.z).toFixed(0)} mm</div>
      ${cands.length ? `<label class="le-cand-wrap">방향 후보
        <select class="le-cand"><option value="">선택…</option>${cands.map((c) => `<option value="${c.id}">후보 ${c.id}${c.id === info.chosen ? ' (자동 선택)' : ''}&nbsp;&nbsp;${fmtDur(c.metrics?.time_s)}&nbsp;&nbsp;${Number(c.metrics?.grams ?? 0).toFixed(0)}g</option>`).join('')}</select></label>` : ''}`;
    el.querySelector('.le-cand')?.addEventListener('change', (e) => {
      const c = cands.find((x) => x.id === e.target.value);
      if (!c) return;
      // candidate.transform is the orientation in the object's own frame
      const m = new THREE.Matrix4().set(...c.transform.flat());
      const q = new THREE.Quaternion();
      m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      const before = worldBox(selected.mesh).getCenter(new THREE.Vector3());
      selected.group.quaternion.copy(q);
      selected.group.updateMatrixWorld(true);
      const after = worldBox(selected.mesh).getCenter(new THREE.Vector3());
      selected.group.position.x += before.x - after.x;
      selected.group.position.y += before.y - after.y;
      dropToBed(selected);
      validate();
      renderSelected();
    });
  }

  function select(it) {
    selected = it;
    if (it && mode !== 'face') tc.attach(it.group); else tc.detach();
    validate();
    renderSelected();
  }

  function setMode(m) {
    mode = m;
    host.querySelectorAll('.le-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    $('.le-hint').textContent = HINTS[m];
    if (m === 'translate') {
      tc.setMode('translate');
      tc.showX = true; tc.showY = true; tc.showZ = false;
    } else if (m === 'rotate') {
      tc.setMode('rotate');
      tc.showX = false; tc.showY = false; tc.showZ = true;
    }
    select(selected);
  }
  host.querySelectorAll('.le-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  host.querySelectorAll('.le-rot').forEach((btn) => btn.addEventListener('click', () => {
    if (!selected) return;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(Number(btn.dataset.deg)));
    rotateWorld(selected, q);
    validate();
    renderSelected();
  }));

  tc.addEventListener('objectChange', () => {
    const it = items.find((x) => x.group === tc.object);
    if (!it) return;
    dropToBed(it);
    validate();
  });
  $('.le-arrange').addEventListener('change', validate);

  // click picking (ignore the end of an orbit/gizmo drag)
  const raycaster = new THREE.Raycaster();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || tc.dragging) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(items.map((it) => it.mesh), false)[0];
    if (!hit) { if (mode !== 'face') select(null); return; }
    const it = items.find((x) => x.mesh === hit.object);
    if (mode === 'face' && it === selected && hit.face) {
      const n = hit.face.normal.clone().transformDirection(it.mesh.matrixWorld);
      rotateWorld(it, new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1)));
      validate();
      renderSelected();
      return;
    }
    select(it);
  });

  $('.le-save').addEventListener('click', async () => {
    const btn = $('.le-save');
    btn.disabled = true;
    try {
      await onSave({
        arrange: $('.le-arrange').checked,
        objects: items.map((it) => {
          it.group.updateMatrixWorld(true);
          return { index: it.info.index, matrix: rowMajor(it.group.matrixWorld) };
        }),
      });
    } finally {
      btn.disabled = false;
    }
  });

  // load objects
  (async () => { try {
    let shelfX = 5, shelfY = EXCLUDE.y1 + 5, rowH = 0, plateX = 0;
    for (const info of objectsInfo) {
      const res = await fetch(`${base}/${info.preview || `preview/obj-${info.index}.stl`}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`#${info.index} 모델을 불러오지 못했습니다 (${res.status})`);
      const buf = await res.arrayBuffer();
      if (disposed) return;
      const geom = loader.parse(buf);
      geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: COLOR_OK, roughness: 0.7, metalness: 0.05 }));
      const group = new THREE.Group();
      group.add(mesh);
      if (Array.isArray(info.bed_matrix) && info.bed_matrix.length === 16) {
        new THREE.Matrix4().set(...info.bed_matrix).decompose(group.position, group.quaternion, group.scale);
      }
      scene.add(group);
      const it = { info, group, mesh, problems: [] };
      items.push(it);
      dropToBed(it);
      if (info.arranged || !Array.isArray(info.bed_matrix)) {
        // the slicer arranged these (maybe over several plates): start from a
        // simple shelf packing on one plate
        const b = worldBox(mesh);
        const w = b.max.x - b.min.x, d = b.max.y - b.min.y;
        if (shelfX + w > BED.x - 5) { shelfX = 5; shelfY += rowH + 5; rowH = 0; }
        if (shelfY > EXCLUDE.y1 + 5 && shelfY + d > BED.y - 5) {
          // plate full: continue on a virtual plate to the right
          plateX += BED.x + 30; shelfX = 5; shelfY = EXCLUDE.y1 + 5; rowH = 0;
        }
        group.position.x += plateX + shelfX - b.min.x;
        group.position.y += shelfY - b.min.y;
        shelfX += w + 5;
        rowH = Math.max(rowH, d);
        group.updateMatrixWorld(true);
      }
    }
    const arranged = objectsInfo.some((o) => o.arranged && Array.isArray(o.bed_matrix));
    $('.le-arrange').checked = arranged && objectsInfo.length > 1;
    const notes = [];
    if (objectsInfo.some((o) => o.cli_oriented)) notes.push('슬라이서 자동 방향 결과는 반영되지 않아 원본 방향에서 시작합니다.');
    if (arranged && objectsInfo.length > 1) notes.push('여러 객체를 임시로 늘어놓았습니다(한 판을 넘으면 오른쪽에 이어서).');
    status.textContent = notes.join(' ');
    setMode('translate');
    select(items.length === 1 ? items[0] : null);
  } catch (err) {
    if (!disposed) status.textContent = `불러오기 실패: ${err.message || err}`;
  } })();

  return {
    dispose() {
      disposed = true;
      tc.detach();
      tc.dispose();
      for (const it of items) { it.mesh.geometry.dispose(); it.mesh.material.dispose(); }
      view.dispose();
      host.remove();
      card.remove();
      status.textContent = '';
    },
  };
}
