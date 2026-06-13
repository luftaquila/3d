import { loadStlWasm } from './stl-wasm.js';

function is3mf(name) {
  return /\.3mf$/i.test(name || '');
}

// Parse a 3MF ArrayBuffer into the same Mesh shape the WASM STL parser returns,
// so the viewer / thumbnail / legend code can treat both formats identically.
// three.js's ThreeMFLoader handles the zip + XML (+ transforms / components /
// build items); we bake each mesh's world transform, flatten to a non-indexed
// triangle-soup positions array, and hand that to the WASM analyzer for
// volume / surface / watertight / edges / bbox.
async function parse3mf(buffer) {
  const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
  const object = new ThreeMFLoader().parse(buffer);
  object.updateMatrixWorld(true);

  const merged = [];
  object.traverse((child) => {
    if (!child.isMesh || !child.geometry) return;
    const indexed = child.geometry.index != null;
    const geom = indexed ? child.geometry.toNonIndexed() : child.geometry;
    const pos = geom.getAttribute('position');
    if (pos) {
      const arr = pos.array;
      const m = child.matrixWorld.elements;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        merged.push(
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        );
      }
    }
    if (indexed) geom.dispose?.();
  });

  if (merged.length < 9) {
    throw new Error('3MF에 미리보기할 메쉬 지오메트리가 없습니다.');
  }
  const mod = await loadStlWasm();
  return mod.analyze_positions(new Float32Array(merged));
}

// Returns a Mesh-shaped object (positions, normals, triangleCount, bbox,
// isWatertight, boundary/nonManifold edges + positions, volume, surfaceArea).
// `name` selects the parser by original extension — the upload route stores
// every model on disk as <id>.stl, so the served URL is not a reliable signal.
export async function parseModel(buffer, name) {
  if (is3mf(name)) return parse3mf(buffer);
  const mod = await loadStlWasm();
  return mod.parse_stl(new Uint8Array(buffer));
}
