# slicer

Cluster-internal worker that slices quote uploads with the Bambu Studio CLI
(P1S 0.4 nozzle, Bambu PLA Basic) at the two in-house process presets
(`0.20mm Custom`, `0.08mm Custom`) and picks a print orientation.

The 3d app queues every uploaded file (`quote_files.slice_status`) and calls
`POST /slice` one file at a time (`src/slicer.js`). Results land on the row as
JSON; artifacts are written to `/data/slices/<quote>/<file>/`:

- `0.20.gcode.3mf`, `0.08.gcode.3mf` — sliced projects, printable as-is
- `candidates/obj-N-X.gcode.3mf` — each explored orientation sliced alone at
  0.20 (for the web preview)

## Pipeline

1. **Geometry only.** A 3MF is reduced to its objects' meshes with
   `bambu-studio --export-stls`; the customer's settings are ignored. Objects
   under 2 mm are assumed to be in metres and scaled ×1000 (flagged).
2. **Candidates.** The uploaded placement plus trimesh stable poses
   (`compute_stable_poses`), de-duplicated by the face that ends up on the bed.
   Candidates that cannot fit 256×256×250 are dropped; the rest get a cheap
   geometric score (overhang area, height), and only the original placement plus
   the best `SLICE_TOP_GEO` within `GEO_PRUNE_RATIO`× of the best are sliced.
   Each exploration slice is capped at `EXPLORE_TIMEOUT_S`.
3. **Score** (lower is better), in seconds of print time:
   `time + W_SUPPORT * support_time + W_OVERHANG_PER_CM2 * overhang_cm² (+900 if
   it would stand on < 25 mm²)`.
4. **LLM** (optional, `ANTHROPIC_API_KEY`). The top 3 candidates per object
   (renders with overhang in red and bed contact in blue, plus the numbers)
   and the customer's quote form answers go to Claude, which picks a
   candidate and may ask for supports everywhere. Without a key, or on any
   API error, the automatic score decides.
5. **Final slices** of the chosen orientation(s) at 0.20 and 0.08.

Files with more than `MAX_EXPLORE_OBJECTS` objects skip 2–4 and use Bambu
Studio's own auto-orient.

Each object's final placement is recorded as `bed_matrix` (object frame →
plate coordinates, row-major 4×4), and a decimated copy of every object is
written to `preview/obj-N.stl` for the web layout editor.

## Manual layout

`POST /slice` with `layout: {arrange, objects: [{index, matrix}]}` skips
exploration and the LLM and slices exactly that placement (each object is
re-seated on z=0; with `arrange: false` it must lie on the plate and clear the
excluded corner). Earlier candidates are kept; only the sliced output
and `result.json` are replaced.

## Sending to the printer

`POST /printer/upload` puts an approved `0.20` / `0.08` project on the P1S's SD
card over implicit FTPS (`printer.py`, port 990, user `bblp`, LAN access
code), verified against the Bambu Lab device CA in `printer-ca.pem` (from the
Home Assistant Bambu Lab integration). The app then starts it through Home
Assistant's `bambu_lab.print_project_file` (`src/printer.js`), which needs the
printer in LAN mode with developer mode on.

## Presets

`profiles/user/*.json` are the user presets exported from Bambu Studio
(`~/Library/Application Support/BambuStudio/user/<id>/process/`). They store
only their diff against a system preset; `flatten.py` resolves `inherits` /
`include` against the presets bundled in the AppImage at image build time,
because the CLI does not. Machine and filament are the system presets
`Bambu Lab P1S 0.4 nozzle` and `Bambu PLA Basic @BBL P1S 0.4 nozzle`.

To update a preset, re-export it into `profiles/user/` and rebuild. To move to
a newer Bambu Studio, change the three `BAMBU_*` build args in the Dockerfile.

## Configuration

| env | default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | enables the LLM step (k8s secret `slicer-secrets`) |
| `PRINTER_HOST` | – | printer IP for uploads |
| `PRINTER_ACCESS_CODE` | – | printer LAN access code (k8s secret `slicer-secrets`) |
| `LLM_MODEL` | `claude-opus-5-5` | |
| `MAX_EXPLORE_OBJECTS` | 6 | |
| `MAX_CANDIDATES` | 6 | |
| `SLICE_TOP_GEO` | 3 | |
| `GEO_PRUNE_RATIO` | 2.0 | |
| `EXPLORE_TIMEOUT_S` | 180 | |
| `W_SUPPORT` | 2.0 | |
| `W_OVERHANG_PER_CM2` | 20 | |
