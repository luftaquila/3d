"""Resolve Bambu Studio presets into self-contained JSON for the CLI.

The CLI loads --load-settings / --load-filaments files as-is: it does not walk
`inherits` for machine/process presets, so a user preset (which stores only its
diff against a system preset) must be flattened first. System presets also
pull G-code templates in through `include`.

Merge order per preset: resolved parent -> included templates -> own keys.
A user preset stores per-extruder-variant vectors where "nil" means "keep the
parent's value at this index"; those are filled from the parent.
"""

import glob
import json
import os
import sys

META_KEYS = {"include", "inherits", "instantiation"}


def index_profiles(profiles_dir, category):
    idx = {}
    for path in glob.glob(os.path.join(profiles_dir, category, "**", "*.json"), recursive=True):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        name = data.get("name")
        if name:
            idx[name] = data
    return idx


def _fill_nil(child, parent):
    if not isinstance(child, list) or not isinstance(parent, list) or not parent:
        return child
    out = []
    for i, v in enumerate(child):
        if v == "nil":
            v = parent[i] if i < len(parent) else parent[0]
        out.append(v)
    return out


def resolve(idx, name, _seen=None):
    seen = _seen or set()
    if name in seen:
        raise ValueError(f"inheritance cycle at {name!r}")
    seen.add(name)
    if name not in idx:
        raise KeyError(f"preset not found: {name!r}")
    return merge(idx, idx[name], seen)


def merge(idx, preset, seen=None):
    seen = seen or set()
    parent_name = preset.get("inherits")
    out = dict(resolve(idx, parent_name, seen)) if parent_name else {}
    for inc in preset.get("include", []) or []:
        for k, v in resolve(idx, inc, set(seen)).items():
            if k not in META_KEYS and k not in ("name", "type", "from", "setting_id"):
                out[k] = v
    for k, v in preset.items():
        if k in META_KEYS:
            continue
        out[k] = _fill_nil(v, out.get(k))
    return out


def flatten_system(profiles_dir, category, name):
    idx = index_profiles(profiles_dir, category)
    out = resolve(idx, name)
    out["from"] = "system"
    out["name"] = name
    return out


def flatten_user(profiles_dir, category, user_preset):
    idx = index_profiles(profiles_dir, category)
    out = merge(idx, user_preset)
    out["from"] = "User"
    # Keep the system parent name: the CLI records it as the system preset.
    out["inherits"] = user_preset["inherits"]
    return out


def main():
    # flatten.py <profiles_dir> <category> (--system NAME | --user FILE) <out>
    profiles_dir, category, mode, arg, out_path = sys.argv[1:6]
    if mode == "--system":
        data = flatten_system(profiles_dir, category, arg)
    elif mode == "--user":
        with open(arg, encoding="utf-8") as fh:
            data = flatten_user(profiles_dir, category, json.load(fh))
    else:
        raise SystemExit(f"unknown mode {mode}")
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
