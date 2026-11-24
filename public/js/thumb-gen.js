import * as THREE from 'three';
import { parseWithThumbnail } from './model-parse.js';
import { renderThumbnail, meshStats } from './thumb-render.js';

// The parse worker renders the thumbnail itself when the browser supports
// WebGL in workers (OffscreenCanvas), so big models never block the page;
// otherwise it returns the mesh and the thumbnail is drawn here.
export async function generateThumbnail(source, name, size = 512, onProgress) {
  const res = await parseWithThumbnail(source, name, size, onProgress);
  if (res.dataUrl) return { dataUrl: res.dataUrl, ...res.stats };
  const canvas = renderThumbnail(THREE, res.mesh, size, (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  });
  return { dataUrl: canvas.toDataURL('image/png'), ...meshStats(res.mesh) };
}
