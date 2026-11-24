// Parse an STL / 3MF into the Mesh shape the viewer, thumbnails and the
// watertight legend use (positions, normals, triangleCount, bbox, isWatertight,
// boundary/nonManifold edges + positions, volume, surfaceArea).
//
// The work runs in a module worker (model-worker.js): a large 3MF holds
// hundreds of MB of XML, and parsing it on the main thread froze the tab for
// over a minute. One worker per call, terminated afterwards to free memory.

export class ModelTooLargeError extends Error {}

// The worker reports progress at least every second or so; a browser can kill
// it (e.g. out of memory on a huge model) without any error event, so give up
// when it has been silent this long. The quote form waits on this on submit.
const WORKER_IDLE_TIMEOUT_MS = 60_000;

function runWorker(message, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
    let timer;
    const finish = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(reject, new Error('모델 분석이 응답하지 않습니다.')), WORKER_IDLE_TIMEOUT_MS);
    };
    worker.onmessage = ({ data }) => {
      if (data.progress != null) { arm(); onProgress?.(data.progress, data.phase); return; }
      if (data.ok) finish(resolve, data);
      else finish(reject, data.tooLarge ? new ModelTooLargeError(data.error) : new Error(data.error));
    };
    worker.onerror = (ev) => finish(reject, new Error(ev.message || '모델을 해석하지 못했습니다.'));
    worker.onmessageerror = () => finish(reject, new Error('모델 분석 결과를 받지 못했습니다.'));
    arm();
    worker.postMessage(message);
  });
}

// source: ArrayBuffer (copied to the worker) or a File/Blob (read there).
// `name` selects the parser by original extension — the upload route stores
// every model on disk as <id>.stl, so the served URL is not a reliable signal.
export async function parseModel(source, name, onProgress) {
  return (await runWorker({ source, name }, onProgress)).mesh;
}

// Parse and, where the browser can, render the thumbnail in the worker too.
// Resolves { dataUrl, stats } or, without worker WebGL, { mesh }.
// onProgress(fraction 0..1, phase: read | parse | analyze | thumbnail).
export async function parseWithThumbnail(source, name, size, onProgress) {
  const { mesh, dataUrl, stats, timings } = await runWorker({ source, name, thumb: size }, onProgress);
  return dataUrl ? { dataUrl, stats, timings } : { mesh };
}
