const WARNING_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 10v4"/><path d="M12 17.5h.01"/></svg>';

export function renderWarningBadge(data) {
  if (!data || data.isWatertight !== false) return '';
  const details = [];
  if (data.boundaryEdges > 0) {
    details.push(`${Number(data.boundaryEdges).toLocaleString()} open edge${data.boundaryEdges === 1 ? '' : 's'}`);
  }
  if (data.nonManifoldEdges > 0) {
    details.push(`${Number(data.nonManifoldEdges).toLocaleString()} non-manifold edge${data.nonManifoldEdges === 1 ? '' : 's'}`);
  }
  const detailLines = details.map((d) => `<span class="card-warning-detail">${d}</span>`).join('');
  return `
    <div class="card-warning-wrap">
      <button type="button" class="card-warning" aria-label="Model warning">${WARNING_SVG}</button>
      <div class="card-warning-popover" role="tooltip">
        <strong>Not watertight</strong>
        ${detailLines}
        <span class="card-warning-hint">Model may fail to slice or print.</span>
      </div>
    </div>
  `;
}

let outsideHandlerInstalled = false;

export function wireWarningBadges(root = document) {
  if (!outsideHandlerInstalled) {
    outsideHandlerInstalled = true;
    document.addEventListener('click', (e) => {
      if (e.target.closest('.card-warning-wrap')) return;
      document.querySelectorAll('.card-warning-wrap.pinned').forEach((w) => w.classList.remove('pinned'));
    });
  }
  root.querySelectorAll('.card-warning-wrap').forEach((wrap) => {
    if (wrap._wtWired) return;
    wrap._wtWired = true;
    wrap.addEventListener('click', (e) => { e.stopPropagation(); });
    const badge = wrap.querySelector('.card-warning');
    badge?.addEventListener('click', () => {
      document.querySelectorAll('.card-warning-wrap.pinned').forEach((other) => {
        if (other !== wrap) other.classList.remove('pinned');
      });
      wrap.classList.toggle('pinned');
    });
  });
}
