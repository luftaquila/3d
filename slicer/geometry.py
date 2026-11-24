"""Mesh loading, orientation candidates, geometric metrics and preview renders."""

import math

import numpy as np
import trimesh

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # noqa: E402

# Bambu Lab P1S build volume (mm). The CLI arranges/validates the real plate;
# this is only a cheap pre-filter for orientations that cannot fit at all.
BED_X, BED_Y, BED_Z = 256.0, 256.0, 250.0

# Same as support_threshold_angle in both process presets: overhangs whose
# slope is below this many degrees from horizontal need support.
SUPPORT_THRESHOLD_DEG = 30.0
OVERHANG_NZ = -math.cos(math.radians(90.0 - SUPPORT_THRESHOLD_DEG))  # -0.5

EXPLORE_MAX_FACES = 200_000
RENDER_MAX_FACES = 12_000


def load_mesh(path):
    mesh = trimesh.load(path, force="mesh", file_type="stl")
    if mesh.is_empty or len(mesh.faces) == 0:
        raise ValueError("empty mesh")
    flags = []
    # An object whose largest dimension is under 2 mm was almost certainly
    # exported in metres; quoting it as-is would be meaningless.
    if float(mesh.extents.max()) < 2.0:
        mesh.apply_scale(1000.0)
        flags.append("scaled_m_to_mm")
    return mesh, flags


def decimate(mesh, max_faces):
    if len(mesh.faces) <= max_faces:
        return mesh
    try:
        return mesh.simplify_quadric_decimation(face_count=max_faces)
    except Exception:  # decimation is an optimisation only
        return mesh


def _down_vector(transform):
    """Direction in the mesh's own frame that ends up pointing at the bed."""
    return transform[:3, :3].T @ np.array([0.0, 0.0, -1.0])


def candidates(mesh, max_n=6):
    """Original placement plus the most probable stable poses, de-duplicated."""
    out = [("original", np.eye(4))]
    try:
        com = mesh.center_mass if mesh.is_watertight else mesh.convex_hull.center_mass
        transforms, _probs = mesh.compute_stable_poses(center_mass=com, n_samples=1)
    except Exception:
        transforms = []
    seen = [_down_vector(np.eye(4))]
    for t in transforms:
        if len(out) >= max_n:
            break
        d = _down_vector(t)
        if any(float(np.dot(d, s)) > 0.995 for s in seen):
            continue
        seen.append(d)
        out.append(("stable", np.array(t)))
    return out


def _translation(v):
    t = np.eye(4)
    t[:3, 3] = v
    return t


def place(mesh, transform):
    """Apply an orientation and drop the mesh onto z=0, centred in XY.

    Returns (mesh, matrix) where matrix maps the input frame to the result.
    """
    m = mesh.copy()
    m.apply_transform(transform)
    lo, hi = m.bounds
    t = _translation([-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]])
    m.apply_transform(t)
    return m, t @ np.asarray(transform, dtype=float)


# bed_exclude_area of the P1S machine preset: front-left corner, 18 x 28 mm.
EXCLUDE = (0.0, 0.0, 18.0, 28.0)
MARGIN = 1.0


def _overlaps_exclude(x0, y0, x1, y1):
    ex0, ey0, ex1, ey1 = EXCLUDE
    return x0 < ex1 + MARGIN and y0 < ey1 + MARGIN and x1 > ex0 and y1 > ey0


def place_on_bed(m):
    """Position a single (already oriented, z>=0) mesh in plate coordinates.

    The CLI's own arrange keeps a wide berth around bed_exclude_area and rejects
    large flat parts that do fit, so single objects are placed here and sliced
    with arrange disabled. Returns (mesh, matrix) or None when it cannot fit.
    """
    for rotate in (False, True):
        mm = m.copy()
        r = trimesh.transformations.rotation_matrix(math.pi / 2, [0, 0, 1]) if rotate else np.eye(4)
        mm.apply_transform(r)
        lo, hi = mm.bounds
        w, d = hi[0] - lo[0], hi[1] - lo[1]
        if w > BED_X - 2 * MARGIN or d > BED_Y - 2 * MARGIN or hi[2] - lo[2] > BED_Z:
            continue
        cx, cy = (BED_X - w) / 2, (BED_Y - d) / 2
        ex1, ey1 = EXCLUDE[2] + MARGIN, EXCLUDE[3] + MARGIN
        for x0, y0 in ((cx, cy), (cx, max(cy, ey1)), (max(cx, ex1), cy)):
            if x0 + w > BED_X - MARGIN or y0 + d > BED_Y - MARGIN:
                continue
            if not _overlaps_exclude(x0, y0, x0 + w, y0 + d):
                t = _translation([x0 - lo[0], y0 - lo[1], -lo[2]])
                mm.apply_transform(t)
                return mm, t @ r
    return None


def check_on_bed(m):
    """Problems with a mesh already in plate coordinates ([] when fine)."""
    lo, hi = m.bounds
    issues = []
    if lo[0] < -0.01 or lo[1] < -0.01 or hi[0] > BED_X + 0.01 or hi[1] > BED_Y + 0.01:
        issues.append("outside the build plate")
    if hi[2] > BED_Z:
        issues.append("taller than the build volume")
    if _overlaps_exclude(lo[0], lo[1], hi[0], hi[1]):
        issues.append("overlaps the excluded front-left corner")
    return issues


def surface_metrics(m):
    """Overhang area needing support and the area resting on the bed (mm²)."""
    nz = m.face_normals[:, 2]
    tri_z = m.vertices[m.faces][:, :, 2]
    area = m.area_faces
    on_bed = (nz < -0.985) & (tri_z.max(axis=1) < 0.05)
    overhang = (nz < OVERHANG_NZ) & (tri_z.mean(axis=1) > 0.3) & ~on_bed
    return {
        "overhang_mm2": float(area[overhang].sum()),
        "contact_mm2": float(area[on_bed].sum()),
        "height_mm": float(m.extents[2]),
        "_overhang_mask": overhang,
        "_bed_mask": on_bed,
    }


def _panel(ax, m, title, elev, azim):
    r = decimate(m, RENDER_MAX_FACES)
    met = surface_metrics(r)
    colors = np.tile(np.array([0.72, 0.74, 0.78, 1.0]), (len(r.faces), 1))
    colors[met["_overhang_mask"]] = [0.90, 0.22, 0.20, 1.0]  # needs support
    colors[met["_bed_mask"]] = [0.20, 0.45, 0.90, 1.0]       # on the bed
    # simple headlight shading so the shape reads in a still image
    light = np.array([0.3, -0.5, 0.8])
    light /= np.linalg.norm(light)
    shade = 0.55 + 0.45 * np.clip(r.face_normals @ light, 0, 1)
    colors[:, :3] *= shade[:, None]
    ax.add_collection3d(Poly3DCollection(r.vertices[r.faces], facecolors=colors, linewidths=0))
    lo, hi = r.bounds
    ext = np.maximum(hi - lo, 1e-3)
    ax.set_xlim(lo[0], hi[0]); ax.set_ylim(lo[1], hi[1]); ax.set_zlim(0, hi[2])
    ax.set_box_aspect(ext)
    # bed outline under the part
    pad = 0.1 * max(ext[0], ext[1])
    bx = [lo[0] - pad, hi[0] + pad, hi[0] + pad, lo[0] - pad, lo[0] - pad]
    by = [lo[1] - pad, lo[1] - pad, hi[1] + pad, hi[1] + pad, lo[1] - pad]
    ax.plot(bx, by, [0] * 5, color="#555", linewidth=0.8)
    ax.view_init(elev=elev, azim=azim)
    ax.set_axis_off()
    ax.set_title(title, fontsize=9)


def render_candidates(rows, out_path):
    """rows: [(label, placed_mesh, caption)] -> one PNG, two views per row."""
    n = len(rows)
    fig = plt.figure(figsize=(8, 3.6 * n), dpi=110)
    for i, (label, m, caption) in enumerate(rows):
        ax1 = fig.add_subplot(n, 2, 2 * i + 1, projection="3d")
        _panel(ax1, m, f"{label} (top) {caption}", elev=28, azim=-60)
        ax2 = fig.add_subplot(n, 2, 2 * i + 2, projection="3d")
        _panel(ax2, m, f"{label} (from below)", elev=-30, azim=120)
    fig.text(0.5, 0.005, "red = overhang needing support, blue = resting on bed",
             ha="center", fontsize=8, color="#444")
    fig.tight_layout()
    fig.savefig(out_path)
    plt.close(fig)
