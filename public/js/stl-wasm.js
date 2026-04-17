let wasmReady;

export function loadStlWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import('/wasm/stl_parser.js');
      await mod.default();
      return mod;
    })();
  }
  return wasmReady;
}
