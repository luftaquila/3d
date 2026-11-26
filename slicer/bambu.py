"""Thin wrapper around the Bambu Studio CLI."""

import json
import os
import re
import subprocess
import tempfile
import zipfile

BAMBU_BIN = os.environ.get("BAMBU_BIN", "/opt/bambu/bin/bambu-studio")
DATA_DIR = os.environ.get("BAMBU_DATADIR", "/tmp/bambu-data")
PROFILE_DIR = os.environ.get("PROFILE_DIR", "/opt/profiles")

# Flattened presets (see flatten.py / Dockerfile).
MACHINE = os.path.join(PROFILE_DIR, "machine.json")
FILAMENT = os.path.join(PROFILE_DIR, "filament.json")
PROCESS = {
    "0.20": os.path.join(PROFILE_DIR, "process-0.20.json"),
    "0.08": os.path.join(PROFILE_DIR, "process-0.08.json"),
}

# CLI return code when an object does not fit on the plate.
RC_NOTHING_ON_PLATE = -50


class SliceError(Exception):
    def __init__(self, message, return_code=None):
        super().__init__(message)
        self.return_code = return_code


def _run(args, timeout):
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(BAMBU_BIN), LC_ALL="C")
    os.makedirs(DATA_DIR, exist_ok=True)
    return subprocess.run(
        [BAMBU_BIN, "--debug", "1", "--datadir", DATA_DIR, *args],
        env=env, capture_output=True, text=True, timeout=timeout,
    )


def export_stls(model_3mf, out_dir, timeout=300):
    """Export each object of a 3MF as its own STL (geometry only)."""
    os.makedirs(out_dir, exist_ok=True)
    # Geometry only, so a 3MF saved by a newer Bambu Studio is fine to read.
    proc = _run(["--allow-newer-file", "--export-stls", out_dir, model_3mf], timeout)
    # natural order: obj_2 before obj_10
    stls = sorted((f for f in os.listdir(out_dir) if f.lower().endswith(".stl")),
                  key=lambda f: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", f)])
    if proc.returncode != 0 or not stls:
        raise SliceError(f"3MF export failed (rc={proc.returncode})", proc.returncode)
    return [os.path.join(out_dir, f) for f in stls]


def preset_value(profile, key):
    """A setting of the (flattened) process preset, e.g. sparse_infill_density."""
    with open(PROCESS[profile], encoding="utf-8") as fh:
        return json.load(fh).get(key)


def process_with_overrides(profile, overrides):
    """Return a process preset path, writing a temp copy when overrides are given."""
    path = PROCESS[profile]
    if not overrides:
        return path
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    data.update(overrides)
    fd, tmp = tempfile.mkstemp(suffix=".json", prefix="process-")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    return tmp


def slice_models(stl_paths, out_dir, profile="0.20", orient=False, arrange=True,
                 export_name=None, overrides=None, timeout=900):
    """Slice the given STLs on one or more plates and return parsed metrics."""
    os.makedirs(out_dir, exist_ok=True)
    result_path = os.path.join(out_dir, "result.json")
    if os.path.exists(result_path):
        os.unlink(result_path)  # never read a previous run's result
    process = process_with_overrides(profile, overrides)
    args = [
        "--load-settings", f"{MACHINE};{process}",
        "--load-filaments", FILAMENT,
        "--arrange", "1" if arrange else "0",
        *(["--allow-rotations"] if arrange else []),  # arrange may turn parts 90°
        "--orient", "1" if orient else "0",
        "--slice", "0",
        "--outputdir", out_dir,
    ]
    if export_name:
        args += ["--export-3mf", export_name]
    try:
        proc = _run(args + list(stl_paths), timeout)
    finally:
        if process != PROCESS[profile]:
            os.unlink(process)

    if not os.path.exists(result_path):
        raise SliceError(f"slicer produced no result (rc={proc.returncode})", proc.returncode)
    with open(result_path, encoding="utf-8") as fh:
        result = json.load(fh)
    rc = result.get("return_code", proc.returncode)
    if rc != 0:
        raise SliceError(result.get("error_string") or f"slicing failed (rc={rc})", rc)

    plates = []
    for p in result.get("sliced_plates", []):
        ft = p.get("feature_type_times", {})
        plates.append({
            "time_s": float(p.get("total_predication", 0)),
            "grams": sum(float(f.get("total_used_g", 0)) for f in p.get("filaments", [])),
            "support_s": float(ft.get("Support", 0)) + float(ft.get("Support interface", 0)),
        })
    out = {
        "plates": len(plates),
        "time_s": sum(p["time_s"] for p in plates),
        "grams": sum(p["grams"] for p in plates),
        "support_s": sum(p["support_s"] for p in plates),
    }
    if export_name:
        out["meters"] = _used_meters(os.path.join(out_dir, export_name))
    return out


def _used_meters(gcode_3mf):
    """Sum filament length (m) from Metadata/slice_info.config."""
    try:
        with zipfile.ZipFile(gcode_3mf) as z:
            info = z.read("Metadata/slice_info.config").decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile):
        return None
    return round(sum(float(m) for m in re.findall(r'used_m="([0-9.]+)"', info)), 2)
