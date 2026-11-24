// Send a sliced project to the Bambu Lab printer (LAN mode):
//   1. the slicer worker uploads the .gcode.3mf to the printer's SD card (FTPS),
//   2. Home Assistant's Bambu Lab integration starts it (bambu_lab.print_project_file).
// Printer state and AMS trays come from the same integration's entities, which
// share the camera entity's prefix (see routes/camera.js).
import { request } from 'undici';
import { config } from './config.js';
import { printerPrefix } from './routes/camera.js';

// Print states in which a new job may be started (the plate must be cleared
// by hand; the UI asks for that).
const STARTABLE = new Set(['idle', 'finish', 'failed']);
const AMS_UNITS = 4;
const TRAYS_PER_UNIT = 4;
export const EXTERNAL_SPOOL = 254; // ams_mapping value for the external spool

function haConfigured() {
  return !!(config.homeassistant.url && config.homeassistant.token && printerPrefix());
}

export function printerConfigured() {
  return !!config.slicer.url && haConfigured();
}

async function ha(method, apiPath, body) {
  const res = await request(`${config.homeassistant.url}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.homeassistant.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    headersTimeout: 15_000,
    bodyTimeout: 15_000,
  });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`Home Assistant ${res.statusCode}: ${text.slice(0, 200)}`);
  return text;
}

async function states(ids) {
  return Promise.all(ids.map(async (id) => {
    try { return JSON.parse(await ha('GET', `/api/states/${encodeURIComponent(id)}`)); } catch { return null; }
  }));
}

const val = (s) => (s && !['unknown', 'unavailable', ''].includes(s.state) ? s.state : null);

export async function printerStatus() {
  if (!printerConfigured()) return { configured: false };
  const p = printerPrefix();
  const trayIds = [];
  for (let u = 1; u <= AMS_UNITS; u++) {
    for (let t = 1; t <= TRAYS_PER_UNIT; t++) trayIds.push([(u - 1) * TRAYS_PER_UNIT + (t - 1), u, t]);
  }
  const [online, status, stage, progress, remaining, task, external, ...trays] = await states([
    `binary_sensor.${p}_online`, `sensor.${p}_print_status`, `sensor.${p}_current_stage`,
    `sensor.${p}_print_progress`, `sensor.${p}_remaining_time`, `sensor.${p}_task_name`,
    `sensor.${p}_externalspool_external_spool`,
    ...trayIds.map(([, u, t]) => `sensor.${p}_ams_${u}_tray_${t}`),
  ]);
  const tray = (s, index, label) => ({
    index,
    label,
    name: s.attributes?.name || val(s) || '',
    type: s.attributes?.type || '',
    color: s.attributes?.color || null,
    remain: Number.isFinite(s.attributes?.remain) && s.attributes.remain >= 0 ? s.attributes.remain : null,
    empty: !!s.attributes?.empty,
    active: !!s.attributes?.active,
  });
  const ams = trays
    .map((s, i) => (s ? tray(s, trayIds[i][0], `AMS ${trayIds[i][1]}-${trayIds[i][2]}`) : null))
    .filter((t) => t && !t.empty);
  const state = val(status);
  const rem = Number(val(remaining));
  return {
    configured: true,
    online: val(online) === 'on',
    state,
    stage: val(stage),
    progress: Number(val(progress)) || 0,
    remainingMin: Number.isFinite(rem) ? Math.round(rem * 60) : null,
    task: val(task),
    startable: val(online) === 'on' && STARTABLE.has(state),
    trays: [
      ...ams,
      ...(external && !external.attributes?.empty ? [tray(external, EXTERNAL_SPOOL, '외부 스풀')] : []),
    ],
  };
}

async function deviceId() {
  const camera = config.homeassistant.cameraEntity;
  const id = (await ha('POST', '/api/template', { template: `{{ device_id('${camera}') }}` })).trim();
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Home Assistant에서 프린터 장치를 찾지 못했습니다');
  return id;
}

async function upload(quoteId, fileId, file, name) {
  const res = await request(`${config.slicer.url}/printer/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteId, fileId, file, name }),
    headersTimeout: 180_000,
    bodyTimeout: 180_000,
  });
  const body = await res.body.json().catch(() => ({}));
  if (res.statusCode !== 200) throw new Error(`프린터 업로드 실패: ${body.error || res.statusCode}`);
  return body;
}

// Printer-side file name: readable, no path characters.
export function printFileName(filename, profile) {
  const base = String(filename).replace(/\.(stl|3mf)$/i, '')
    .replace(/[\x00-\x1f/\\]/g, '_').trim().slice(0, 80) || 'model';
  return `${base}_${profile}.gcode.3mf`;
}

// Upload and start. opts: { quoteId, fileId, filename, profile, plate, tray,
// bedLeveling, timelapse }. Throws with a user-facing message on failure.
export async function sendToPrinter(opts) {
  const status = await printerStatus();
  if (!status.configured) throw new Error('프린터 연동이 설정되지 않았습니다');
  if (!status.online) throw new Error('프린터가 오프라인입니다');
  if (!status.startable) throw new Error(`프린터가 출력을 시작할 수 없는 상태입니다 (${status.state || '알 수 없음'})`);
  if (!status.trays.some((t) => t.index === opts.tray)) throw new Error('선택한 필라멘트 슬롯이 없습니다');

  const name = printFileName(opts.filename, opts.profile);
  await upload(opts.quoteId, opts.fileId, `${opts.profile}.gcode.3mf`, name);
  const useAms = opts.tray !== EXTERNAL_SPOOL;
  await ha('POST', '/api/services/bambu_lab/print_project_file', {
    device_id: await deviceId(),
    filepath: name,
    plate: opts.plate,
    timelapse: !!opts.timelapse,
    bed_leveling: !!opts.bedLeveling,
    flow_cali: true,
    vibration_cali: true,
    layer_inspect: false, // no lidar on P1S
    use_ams: useAms,
    ams_mapping: String(useAms ? opts.tray : 0),
  });
  return { name };
}
