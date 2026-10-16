import { config } from './config.js';
import { estimateFilament, estimateCost } from '../public/js/filament.js';
import { sendAlimtalk, alimtalkConfigured, getAlimtalkTemplates } from './alimtalk.js';

// New-quote notification to the admin's KakaoTalk via AlimTalk. The template
// (config.adminNotify.templateCode) must be Kakao-approved; its body may use
// #{name} #{phone} #{email} #{count} #{answers} #{filament} #{grams} #{cost}
// #{id} #{time}. Unknown #{vars} are left as-is so NCP rejects a mismatched
// body instead of sending something silently wrong.

const lastSendByUser = new Map();
const DEBOUNCE_MS = 60 * 1000;
const MAX_TRACKED_USERS = 1000;
// AlimTalk content limit (template body with variables filled).
const MAX_CONTENT = 1000;

function markSent(userEmail, now) {
  // Opportunistic TTL sweep: entries older than DEBOUNCE_MS serve no purpose.
  for (const [k, t] of [...lastSendByUser]) {
    if (now - t >= DEBOUNCE_MS) lastSendByUser.delete(k);
  }
  // Move/insert this entry to the tail so head is least-recently-sent for LRU.
  lastSendByUser.delete(userEmail);
  lastSendByUser.set(userEmail, now);
  // Hard cap: evict from head (oldest) if over limit.
  while (lastSendByUser.size > MAX_TRACKED_USERS) {
    const oldest = lastSendByUser.keys().next().value;
    if (oldest === undefined) break;
    lastSendByUser.delete(oldest);
  }
}

function fmtKst(ms) {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Pure builder for the template variables — kept separate from the send path
// so it can be checked offline.
export function buildQuoteVars({
  quoteId, userEmail, phone, name, fileCount,
  createdAt, files = [], answers = [], estimateConfig = {},
}) {
  const fileList = Array.isArray(files) ? files : [];
  const answerList = Array.isArray(answers) ? answers : [];
  const count = Number.isFinite(fileCount) ? fileCount : fileList.length;

  // Customer's entries for the configurable quote-form fields.
  const answersText = answerList.length
    ? answerList.map((a) => `· ${a.label}: ${String(a.value).replace(/\r?\n/g, ' ')}`).join('\n')
    : '-';

  // Rough filament/cost estimate (same model as the viewer legend). Reference
  // only — admin enters the real quote.
  const wallMm = Number.isFinite(estimateConfig.wallMm) ? estimateConfig.wallMm : undefined;
  const infillPct = Number.isFinite(estimateConfig.infillPct) ? estimateConfig.infillPct : undefined;
  const pricePerM = Number.isFinite(estimateConfig.pricePerM) ? estimateConfig.pricePerM : undefined;
  let totalGrams = 0, totalMeters = 0, anyGeom = false;
  for (const f of fileList) {
    if (Number.isFinite(f.volumeMm3) && f.volumeMm3 > 0) {
      anyGeom = true;
      const est = estimateFilament(f.volumeMm3, f.surfaceAreaMm2, { wallMm, infillPct });
      totalGrams += est.grams;
      totalMeters += est.meters;
    }
  }

  return {
    id: quoteId,
    name,
    phone,
    email: userEmail,
    count: String(count),
    time: fmtKst(createdAt),
    answers: answersText,
    filament: anyGeom ? totalMeters.toFixed(1) : '-',
    grams: anyGeom ? Math.round(totalGrams).toLocaleString('ko-KR') : '-',
    cost: anyGeom ? estimateCost(totalMeters, pricePerM).toLocaleString('ko-KR') : '-',
  };
}

export function fillTemplate(content, vars) {
  return String(content || '').replace(/#\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

// Answers are the only unbounded variable; shrink them until the body fits.
function renderContent(content, vars) {
  let out = fillTemplate(content, vars);
  if (out.length <= MAX_CONTENT) return out;
  const over = out.length - MAX_CONTENT;
  const answers = vars.answers.slice(0, Math.max(0, vars.answers.length - over - 1)) + '…';
  out = fillTemplate(content, { ...vars, answers });
  return out.slice(0, MAX_CONTENT);
}

export async function sendQuoteNotification(log, opts) {
  const { quoteId, userEmail } = opts;
  const { phone: to, templateCode } = config.adminNotify;
  if (!to || !templateCode || !alimtalkConfigured()) {
    log.info({ quoteId }, 'admin alimtalk disabled, skipping notification');
    return;
  }

  const now = Date.now();
  const last = lastSendByUser.get(userEmail) ?? 0;
  if (now - last < DEBOUNCE_MS) {
    log.info({ quoteId }, 'admin alimtalk debounced');
    return;
  }
  markSent(userEmail, now);

  const tpls = await getAlimtalkTemplates(log);
  const tpl = tpls.find((t) => t.code === templateCode);
  if (!tpl) {
    log.warn({ quoteId, templateCode }, 'admin alimtalk template not found');
    return;
  }

  const content = renderContent(tpl.content, buildQuoteVars(opts));
  const result = await sendAlimtalk(log, { to, templateCode, content, buttons: tpl.buttons || [] });
  if (result.ok) log.info({ quoteId }, 'admin alimtalk notification sent');
  else log.warn({ quoteId, status: result.status }, 'admin alimtalk send failed');
}
