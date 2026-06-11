// Rough filament-usage estimate from model volume. This is NOT a slicer — it
// ignores walls, top/bottom layers, supports and brim, so treat it as a ballpark
// the admin corrects with the real slicer figures.
//
// Assumptions (see CLAUDE.md): PLA density 1.24 g/cm³, 1.75mm filament,
// 5% infill applied uniformly to the model volume.
export const FILAMENT_DENSITY_G_CM3 = 1.24;
export const FILAMENT_DIAMETER_MM = 1.75;
export const INFILL_FACTOR = 0.05;
// Rough material price applied to estimated filament length.
export const FILAMENT_PRICE_PER_M = 500; // KRW per meter

const FILAMENT_AREA_MM2 = Math.PI * (FILAMENT_DIAMETER_MM / 2) ** 2; // ≈ 2.405 mm²

// volumeMm3 → { grams, meters }. Returns zeros for non-positive input.
export function estimateFilament(volumeMm3) {
  const v = Number(volumeMm3);
  if (!Number.isFinite(v) || v <= 0) return { grams: 0, meters: 0 };
  const plasticMm3 = v * INFILL_FACTOR;
  const grams = (plasticMm3 / 1000) * FILAMENT_DENSITY_G_CM3;
  const meters = plasticMm3 / FILAMENT_AREA_MM2 / 1000;
  return { grams, meters };
}

// Estimated cost (KRW) from filament length in meters. Rounded to the won.
export function estimateCost(meters) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.round(m * FILAMENT_PRICE_PER_M);
}
