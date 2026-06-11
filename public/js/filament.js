// Rough filament-usage estimate from model geometry. This is NOT a slicer, but
// it models the two things that dominate real filament use:
//   1. the solid skin — outer walls + top/bottom layers ≈ surface area × wall
//      thickness (this is usually the bulk, which a flat infill% misses), and
//   2. sparse infill of the remaining interior volume.
//
// Tunable params (wall thickness / infill % / price) come from admin settings so
// the owner can calibrate against a known slicer result. Density/diameter are
// fixed (PLA 1.24 g/cm³, 1.75 mm filament).
export const FILAMENT_DENSITY_G_CM3 = 1.24;
export const FILAMENT_DIAMETER_MM = 1.75;

export const ESTIMATE_DEFAULTS = {
  wallMm: 1.0,      // effective solid skin thickness (walls + top/bottom lumped)
  infillPct: 15,    // sparse infill density of the interior
  pricePerM: 500,   // KRW per meter of filament
};

const FILAMENT_AREA_MM2 = Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2; // ≈ 2.405 mm²

// { volumeMm3, surfaceAreaMm2, wallMm, infillPct } → { grams, meters, plasticMm3 }.
// Falls back to pure-infill of volume when surface area is unavailable.
export function estimateFilament(volumeMm3, surfaceAreaMm2, opts = {}) {
  const v = Number(volumeMm3);
  if (!Number.isFinite(v) || v <= 0) return { grams: 0, meters: 0, plasticMm3: 0 };
  const wallMm = Number.isFinite(opts.wallMm) ? opts.wallMm : ESTIMATE_DEFAULTS.wallMm;
  const infillFrac = (Number.isFinite(opts.infillPct) ? opts.infillPct : ESTIMATE_DEFAULTS.infillPct) / 100;

  const a = Number(surfaceAreaMm2);
  const shellMm3 = Number.isFinite(a) && a > 0 ? Math.min(a * wallMm, v) : 0;
  const interiorMm3 = Math.max(0, v - shellMm3);
  const plasticMm3 = shellMm3 + infillFrac * interiorMm3;

  const grams = (plasticMm3 / 1000) * FILAMENT_DENSITY_G_CM3;
  const meters = plasticMm3 / FILAMENT_AREA_MM2 / 1000;
  return { grams, meters, plasticMm3 };
}

// Estimated cost (KRW) from filament length in meters, truncated down to the
// nearest 100원.
export function estimateCost(meters, pricePerM) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m <= 0) return 0;
  const rate = Number.isFinite(pricePerM) ? pricePerM : ESTIMATE_DEFAULTS.pricePerM;
  return Math.floor((m * rate) / 100) * 100;
}
