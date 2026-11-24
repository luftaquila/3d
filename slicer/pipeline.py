"""One quote file -> orientation choice -> 0.20 / 0.08 slicing results."""

import json
import os
import shutil
import string
import subprocess
import tempfile
import time

import numpy as np

import bambu
import geometry
import llm

# Candidate exploration slices every candidate of every object; beyond this
# many objects (e.g. a kit of 40 parts in one 3MF) we let Bambu auto-orient.
MAX_EXPLORE_OBJECTS = int(os.environ.get("MAX_EXPLORE_OBJECTS", "6"))
MAX_CANDIDATES = int(os.environ.get("MAX_CANDIDATES", "6"))
LLM_TOP_K = 3
# Orientations actually sliced per object (besides the original placement).
SLICE_TOP_GEO = int(os.environ.get("SLICE_TOP_GEO", "3"))
EXPLORE_TIMEOUT_S = int(os.environ.get("EXPLORE_TIMEOUT_S", "180"))
# Skip slicing candidates whose geometric score is far worse than the best one.
GEO_PRUNE_RATIO = float(os.environ.get("GEO_PRUNE_RATIO", "2.0"))

# Score = print time + extra weight on support work + overhang surface penalty
# (+ toppling penalty). Units are "seconds of print time equivalent".
W_SUPPORT = float(os.environ.get("W_SUPPORT", "2.0"))
W_OVERHANG_PER_CM2 = float(os.environ.get("W_OVERHANG_PER_CM2", "20"))
SMALL_CONTACT_MM2 = 25.0
TOPPLE_PENALTY = 900.0

PROFILES = ("0.20", "0.08")


def _is_zip(path):
    with open(path, "rb") as fh:
        return fh.read(4) == b"PK\x03\x04"


def _score(m):
    s = m["time_s"] + W_SUPPORT * m["support_s"] + W_OVERHANG_PER_CM2 * m["overhang_mm2"] / 100.0
    if m["contact_mm2"] < SMALL_CONTACT_MM2 and m["height_mm"] > 20:
        s += TOPPLE_PENALTY
    return s


def _caption(m):
    t = int(m["time_s"])
    return f"{t // 3600}h{(t % 3600) // 60:02d}m {m['grams']:.0f}g sup {int(m['support_s']) // 60}m"


def _geo_score(surf):
    # Cheap pre-ranking before any slicing: support area dominates, height is
    # a proxy for layer count. Same "seconds-ish" scale as _score.
    return W_OVERHANG_PER_CM2 * 3 * surf["overhang_mm2"] / 100.0 + 10.0 * surf["height_mm"]


def _explore(obj, work, out_dir):
    os.makedirs(work, exist_ok=True)
    mesh = geometry.decimate(obj["mesh"], geometry.EXPLORE_MAX_FACES)
    cands = []
    for i, (kind, transform) in enumerate(geometry.candidates(mesh, MAX_CANDIDATES)):
        cid = string.ascii_uppercase[i]
        placed, _ = geometry.place(mesh, transform)
        cand = {"id": cid, "kind": kind, "transform": transform.tolist(), "feasible": False}
        bed = geometry.place_on_bed(placed)
        on_bed = bed[0] if bed else None
        if on_bed is None:
            cand["error"] = "does not fit the build plate"
        else:
            surf = geometry.surface_metrics(placed)
            cand.update(_placed=placed, _on_bed=on_bed, _surf=surf, geo_score=_geo_score(surf))
        cands.append(cand)

    # Slice the original placement plus the best few by geometry. A pose that
    # needs a forest of supports can take many minutes to slice and would lose
    # anyway, so it is pruned here and capped by EXPLORE_TIMEOUT_S below.
    fitting = [c for c in cands if "_placed" in c]
    keep = {c["id"] for c in fitting if c["kind"] == "original"}
    if fitting:
        best_geo = min(c["geo_score"] for c in fitting)
        ranked = sorted(fitting, key=lambda c: c["geo_score"])[:SLICE_TOP_GEO]
        keep |= {c["id"] for c in ranked if c["geo_score"] <= GEO_PRUNE_RATIO * best_geo + 60}
    for cand in fitting:
        if cand["id"] not in keep:
            cand["error"] = "pruned by geometry (more overhang / taller)"
    queue = [c for c in fitting if c["id"] in keep]
    # Nothing sliceable among the shortlist (e.g. a flat plate that only fits
    # standing up): fall back to the pruned ones, best geometry first.
    fallback = sorted((c for c in fitting if c["id"] not in keep), key=lambda c: c["geo_score"])
    while True:
        if not queue and fallback and not any(c["feasible"] for c in cands):
            queue, fallback = fallback, []
        if not queue:
            break
        cand = queue.pop(0)
        stl = os.path.join(work, f"cand-{cand['id']}.stl")
        cand["_on_bed"].export(stl)
        # kept so the web preview can show each sliced candidate
        name = f"obj-{obj['index']}-{cand['id']}.gcode.3mf"
        cand_out = os.path.join(work, f"out-{cand['id']}")
        try:
            sliced = bambu.slice_models([stl], cand_out, "0.20", arrange=False,
                                        export_name=name, timeout=EXPLORE_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            cand["error"] = f"slicing took over {EXPLORE_TIMEOUT_S}s (heavy supports)"
            continue
        except bambu.SliceError as e:
            cand["error"] = str(e)
            continue
        metrics = {k: v for k, v in cand["_surf"].items() if not k.startswith("_")}
        metrics.update(time_s=sliced["time_s"], grams=sliced["grams"], support_s=sliced["support_s"],
                       meters=sliced.get("meters"))
        cand.update(feasible=True, metrics=metrics, score=_score(metrics))
        cand.pop("error", None)
        os.makedirs(os.path.join(out_dir, "candidates"), exist_ok=True)
        shutil.move(os.path.join(cand_out, name), os.path.join(out_dir, "candidates", name))
        cand["file"] = f"candidates/{name}"
    return cands


PREVIEW_MAX_FACES = 150_000


def _matrix_list(m):
    return [round(float(v), 6) for v in np.asarray(m, dtype=float).reshape(-1)]


def _load_objects(src, work, filename):
    """Geometry only: a 3MF is reduced to its objects' meshes (same order every run)."""
    if _is_zip(src):
        link = os.path.join(work, "input.3mf")
        os.symlink(src, link)
        paths, source = bambu.export_stls(link, os.path.join(work, "objects")), "3mf"
    else:
        paths, source = [src], "stl"
    objects = []
    for i, p in enumerate(paths):
        mesh, flags = geometry.load_mesh(p)
        name = filename if len(paths) == 1 else os.path.basename(p)
        objects.append({"index": i + 1, "name": name, "mesh": mesh, "flags": flags})
    return objects, source


def _object_info(obj):
    return {
        "index": obj["index"], "name": obj["name"], "flags": obj["flags"],
        "triangles": int(len(obj["mesh"].faces)),
        "watertight": bool(obj["mesh"].is_watertight),
        "extents_mm": [round(float(x), 1) for x in obj["mesh"].extents],
        "preview": f"preview/obj-{obj['index']}.stl",
    }


def _write_previews(objects, out_dir):
    """Decimated meshes in the objects' own frame, for the web layout editor."""
    d = os.path.join(out_dir, "preview")
    os.makedirs(d, exist_ok=True)
    for obj in objects:
        geometry.decimate(obj["mesh"], PREVIEW_MAX_FACES).export(os.path.join(d, f"obj-{obj['index']}.stl"))


def _auto_plan(job, objects, result, out_dir, work):
    """Candidate exploration + LLM; returns the final-slice plan."""
    explore = len(objects) <= MAX_EXPLORE_OBJECTS
    result["mode"] = "explore" if explore else "auto"
    if not explore:
        result["warnings"].append(
            f"{len(objects)} objects: orientation left to Bambu auto-orient (explore limit {MAX_EXPLORE_OBJECTS})")

    llm_objects = []
    for obj, info in zip(objects, result["objects"]):
        if not explore:
            continue
        cands = _explore(obj, os.path.join(work, f"obj{obj['index']}"), out_dir)
        feasible = sorted((c for c in cands if c["feasible"]), key=lambda c: c["score"])
        info["candidates"] = [{k: v for k, v in c.items() if not k.startswith("_")} for c in cands]
        if not feasible:
            info["error"] = "no orientation fits the P1S build volume or slices successfully"
            continue
        top = feasible[:LLM_TOP_K]
        info.update(chosen=feasible[0]["id"], chosen_by="score", shortlist=[c["id"] for c in top])
        obj["by_id"] = {c["id"]: c for c in cands}
        llm_objects.append({
            "index": obj["index"], "name": obj["name"], "best": feasible[0]["id"],
            "_top": top,
            "candidates": [{"id": c["id"], "metrics": c["metrics"], "score": c["score"]} for c in top],
        })

    failed = [o for o in result["objects"] if o.get("error")]
    if failed:
        raise bambu.SliceError("; ".join(f"{o['name']}: {o['error']}" for o in failed))

    if llm_objects and job.get("use_llm", True) and llm.configured():
        # renders of the shortlist are only for the model (the web UI shows
        # the sliced candidates instead)
        for o in llm_objects:
            o["image_path"] = os.path.join(work, f"object-{o['index']}.png")
            geometry.render_candidates(
                [(c["id"], c["_placed"], _caption(c["metrics"])) for c in o.pop("_top")],
                o["image_path"])
        decision, err = llm.choose(job["filename"], job.get("answers", []), llm_objects)
        if err:
            result["llm"] = {"used": False, "error": err}
        else:
            result["llm"] = {"used": True, "model": decision.get("model"), "summary": decision.get("summary", "")}
            by_index = {o["index"]: o for o in result["objects"]}
            for d in decision.get("objects", []):
                info = by_index.get(d.get("object"))
                if not info or d.get("candidate") not in info.get("shortlist", []):
                    continue
                info.update(chosen=d["candidate"], chosen_by="llm",
                            reason=d.get("reason", ""), concerns=d.get("concerns", ""),
                            supports=d.get("supports", "profile"))
    elif llm_objects:
        result["llm"] = {"used": False, "error": "LLM not configured" if not llm.configured() else "disabled"}

    # A single explored object is placed by hand (see geometry.place_on_bed);
    # several objects are left to the CLI's arrange, possibly over plates.
    plan = []
    arrange = True
    for obj, info in zip(objects, result["objects"]):
        if explore:
            mesh, m = geometry.place(obj["mesh"], np.array(obj["by_id"][info["chosen"]]["transform"]))
            if len(objects) == 1:
                bed = geometry.place_on_bed(mesh)
                if bed is not None:
                    mesh, m2 = bed
                    m, arrange = m2 @ m, False
        else:
            mesh, m = geometry.place(obj["mesh"], np.eye(4))
        plan.append((obj, info, mesh, m))
    return plan, arrange, not explore


def _manual_plan(layout, objects, result):
    """Place every object with the matrix the admin chose in the web editor."""
    arrange = bool(layout.get("arrange"))
    given = {int(o["index"]): o["matrix"] for o in layout.get("objects", [])}
    plan, problems = [], []
    for obj, info in zip(objects, result["objects"]):
        if obj["index"] not in given:
            raise bambu.SliceError(f"layout has no placement for object {obj['index']}")
        m = np.array(given[obj["index"]], dtype=float).reshape(4, 4)
        r = m[:3, :3]
        if (not np.all(np.isfinite(m)) or not np.allclose(m[3], [0, 0, 0, 1], atol=1e-6)
                or not np.allclose(r @ r.T, np.eye(3), atol=1e-3) or np.linalg.det(r) < 0):
            raise bambu.SliceError(f"object {obj['index']}: placement must be a rotation + translation")
        mesh = obj["mesh"].copy()
        mesh.apply_transform(m)
        drop = np.eye(4)
        drop[2, 3] = -mesh.bounds[0][2]  # rest on the bed whatever the editor sent
        mesh.apply_transform(drop)
        m = drop @ m
        if not arrange:
            problems += [f"#{obj['index']} {p}" for p in geometry.check_on_bed(mesh)]
        info["chosen_by"] = "manual"
        plan.append((obj, info, mesh, m))
    if problems:
        raise bambu.SliceError("layout: " + "; ".join(problems))
    return plan, arrange, False


def _choose_plan(choose, objects, result):
    """Re-slice with the explored candidates the admin picked in the web UI
    ({object index: candidate id}); other objects keep their current choice.
    Placement is the same as for an automatic run, so a hand-made layout of
    the other objects can't be kept: refuse instead of silently dropping it."""
    kept_manual = [info["index"] for info in result["objects"]
                   if info.get("chosen_by") == "manual" and str(info["index"]) not in choose]
    if kept_manual:
        raise bambu.SliceError(
            "objects " + ", ".join(f"#{i}" for i in kept_manual)
            + " were placed by hand; change them in the layout editor or pick a candidate for every object")
    plan = []
    for obj, info in zip(objects, result["objects"]):
        by_id = {c["id"]: c for c in info.get("candidates") or [] if c.get("feasible") and c.get("transform")}
        key = str(obj["index"])
        cid = choose.get(key, info.get("chosen"))
        if cid not in by_id:
            raise bambu.SliceError(f"object {obj['index']}: candidate {cid} was not explored")
        if key in choose:
            info.update(chosen=cid, chosen_by="admin")
            for k in ("reason", "concerns", "supports"):  # the LLM's notes no longer apply
                info.pop(k, None)
            if result.get("llm", {}).get("used"):
                result["llm"]["overridden"] = True
        mesh, m = geometry.place(obj["mesh"], np.array(by_id[cid]["transform"]))
        plan.append([obj, info, mesh, m])
    arrange = True
    if len(plan) == 1:
        bed = geometry.place_on_bed(plan[0][2])
        if bed is not None:
            plan[0][2], m2 = bed
            plan[0][3] = m2 @ plan[0][3]
            arrange = False
    return [tuple(p) for p in plan], arrange, False


def _final_slice(plan, arrange, orient, result, out_dir, work):
    overrides = None
    if any(info.get("supports") == "everywhere" for _, info, _, _ in plan):
        overrides = {"support_on_build_plate_only": "0"}
        result["warnings"].append("supports enabled everywhere (not only from the build plate)")
    final_dir = os.path.join(work, "final")
    os.makedirs(final_dir)
    stls = []
    for obj, info, mesh, m in plan:
        path = os.path.join(final_dir, f"object-{obj['index']}.stl")
        mesh.export(path)
        stls.append(path)
        # Object frame -> plate coordinates. When the CLI arranges (or orients)
        # the final position is its choice; the editor then starts from this
        # orientation and re-packs.
        info.update(bed_matrix=_matrix_list(m), arranged=bool(arrange), cli_oriented=bool(orient))
    result["layout"] = {"arrange": bool(arrange), "orient": bool(orient)}
    for profile in PROFILES:
        name = f"{profile}.gcode.3mf"
        sliced = bambu.slice_models(stls, os.path.join(work, f"final-{profile}"), profile,
                                    orient=orient, arrange=arrange, export_name=name, overrides=overrides)
        shutil.move(os.path.join(work, f"final-{profile}", name), os.path.join(out_dir, name))
        sliced["file"] = name
        result["profiles"][profile] = sliced


def process(job):
    started = time.time()
    out_dir = job["out_dir"]
    layout = job.get("layout")
    choose = job.get("choose")
    previous = None
    if layout or choose:
        # Re-slice with a manual layout or chosen candidates: keep the
        # exploration artifacts (previews, sliced candidates) and replace only
        # the sliced output.
        try:
            with open(os.path.join(out_dir, "result.json"), encoding="utf-8") as fh:
                previous = json.load(fh)
        except (OSError, json.JSONDecodeError):
            previous = None
        os.makedirs(out_dir, exist_ok=True)
        for profile in PROFILES:
            try:
                os.unlink(os.path.join(out_dir, f"{profile}.gcode.3mf"))
            except FileNotFoundError:
                pass
    else:
        shutil.rmtree(out_dir, ignore_errors=True)
        os.makedirs(out_dir)

    work = tempfile.mkdtemp(prefix="slice-")
    result = {"version": 1, "warnings": [], "objects": [], "profiles": {}, "llm": {"used": False}}
    if previous:
        result.update({k: previous[k] for k in ("mode", "llm", "objects") if k in previous})
    try:
        objects, result["source"] = _load_objects(job["path"], work, job["filename"])
        if len(result["objects"]) != len(objects):
            result["objects"] = [_object_info(o) for o in objects]
        else:
            for info, obj in zip(result["objects"], objects):
                info.setdefault("preview", _object_info(obj)["preview"])
        _write_previews(objects, out_dir)

        if layout:
            plan, arrange, orient = _manual_plan(layout, objects, result)
        elif choose:
            plan, arrange, orient = _choose_plan(choose, objects, result)
        else:
            plan, arrange, orient = _auto_plan(job, objects, result, out_dir, work)
        _final_slice(plan, arrange, orient, result, out_dir, work)
        result["status"] = "done"
    except bambu.SliceError as e:
        result.update(status="failed", error=str(e), return_code=e.return_code)
    except subprocess.TimeoutExpired as e:
        result.update(status="failed", error=f"slicing timed out after {int(e.timeout)}s")
    except Exception as e:  # keep the worker alive and report
        result.update(status="failed", error=f"{type(e).__name__}: {e}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    result["elapsed_s"] = round(time.time() - started, 1)
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    return result


def _file_orientation(info):
    """Orientation (4x4, object frame) the file's own slicing settled on, plus
    a label: an explored candidate, the rotation of a manual layout, or the
    upload pose when the file was never explored (Bambu auto-orient files)."""
    if info:
        if info.get("chosen_by") == "manual" and info.get("bed_matrix"):
            m = np.eye(4)
            m[:3, :3] = np.array(info["bed_matrix"], dtype=float).reshape(4, 4)[:3, :3]
            return m, "manual"
        by_id = {c["id"]: c for c in info.get("candidates") or [] if c.get("transform")}
        if info.get("chosen") in by_id:
            return np.array(by_id[info["chosen"]]["transform"], dtype=float), info.get("chosen_by") or "score"
    return np.eye(4), "upload"


def process_plate(job):
    """Put every object of several files of one quote on shared plate(s).

    job: {out_dir, slices_dir, files: [{file_id, path, filename}], layout?}.
    Each object keeps the orientation its file's own slicing chose (see
    _file_orientation); Bambu Studio's arrange then packs them, over several
    plates if needed. With layout, exactly that placement is sliced (the
    layout editor works on the plate like on a single file).
    """
    started = time.time()
    out_dir = job["out_dir"]
    layout = job.get("layout")
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir)

    work = tempfile.mkdtemp(prefix="plate-")
    result = {"version": 1, "kind": "plate", "warnings": [], "objects": [], "profiles": {},
              "llm": {"used": False}, "mode": "plate", "files": []}
    try:
        objects = []
        for n, f in enumerate(job["files"]):
            try:
                with open(os.path.join(job["slices_dir"], f["file_id"], "result.json"), encoding="utf-8") as fh:
                    own = json.load(fh)
            except (OSError, json.JSONDecodeError):
                own = {}
            own_infos = {o["index"]: o for o in own.get("objects", [])} if own.get("status") == "done" else {}
            loaded, _source = _load_objects(f["path"], os.path.join(work, f"f{n}"), f["filename"])
            result["files"].append({"file_id": f["file_id"], "filename": f["filename"], "objects": len(loaded),
                                    "sliced": bool(own_infos)})
            if not own_infos:
                result["warnings"].append(f"{f['filename']}: not sliced on its own yet, using the upload orientation")
            for obj in loaded:
                k = len(objects) + 1
                orient, source = _file_orientation(own_infos.get(obj["index"]))
                name = f["filename"] if len(loaded) == 1 else f"{f['filename']} #{obj['index']}"
                objects.append({"index": k, "name": name, "mesh": obj["mesh"], "flags": obj["flags"],
                                "orient": orient})
                info = _object_info(objects[-1])
                info.update(file_id=f["file_id"], file_object=obj["index"], orientation=source)
                own_info = own_infos.get(obj["index"]) or {}
                if own_info.get("supports") == "everywhere":
                    info["supports"] = "everywhere"
                result["objects"].append(info)
        if not objects:
            raise bambu.SliceError("no objects to place")
        _write_previews(objects, out_dir)

        if layout:
            plan, arrange, orient = _manual_plan(layout, objects, result)
            for info in result["objects"]:
                info["orientation"] = "manual"  # the editor's rotation replaces the file's
        else:
            plan = []
            for obj, info in zip(objects, result["objects"]):
                mesh, m = geometry.place(obj["mesh"], obj["orient"])
                plan.append((obj, info, mesh, m))
            arrange, orient = True, False
        _final_slice(plan, arrange, orient, result, out_dir, work)
        result["status"] = "done"
    except bambu.SliceError as e:
        result.update(status="failed", error=str(e), return_code=e.return_code)
    except subprocess.TimeoutExpired as e:
        result.update(status="failed", error=f"slicing timed out after {int(e.timeout)}s")
    except Exception as e:  # keep the worker alive and report
        result.update(status="failed", error=f"{type(e).__name__}: {e}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    result["elapsed_s"] = round(time.time() - started, 1)
    with open(os.path.join(out_dir, "result.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False, indent=1)
    return result
