"""Cluster-internal HTTP front for the slicing pipeline.

POST /slice  {quoteId, fileId, path, filename, answers:[{label,value}], useLlm,
              layout?: {arrange, objects:[{index, matrix:[16, row-major]}]}}
  Without layout: explore orientations (+LLM). With layout: slice exactly that
  placement (object frame -> plate coordinates), keeping earlier artifacts.
  choose?: {"<object index>": "<candidate id>"} instead re-slices with those
  explored candidates.
  -> runs synchronously (one job at a time; 409 while busy), returns result JSON.
POST /printer/upload  {quoteId, fileId, file: "0.20.gcode.3mf" | "0.08.gcode.3mf", name}
  Uploads that sliced project to the printer's SD card root as `name` (FTPS).
  -> {filepath, size}; 503 if the printer is not configured, 409 while busy.
GET  /healthz
"""

import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pipeline
import printer

UPLOADS_DIR = os.path.realpath(os.environ.get("UPLOADS_DIR", "/data/uploads"))
SLICES_DIR = os.path.realpath(os.environ.get("SLICES_DIR", "/data/slices"))
ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
MAX_BODY = 256 * 1024

_lock = threading.Lock()
_upload_lock = threading.Lock()  # independent of slicing
CHOOSE_KEY = re.compile(r"^\d{1,3}$")
CHOOSE_VAL = re.compile(r"^[A-Z]$")
PRINT_FILE = re.compile(r"^0\.(20|08)\.gcode\.3mf$")
# printer-side file name: no path separators or control characters
BAD_NAME = re.compile(r"[\x00-\x1f/\\]")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"ok": True, "busy": _lock.locked()})
        self._send(404, {"error": "not found"})

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            req = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return None
        return req if isinstance(req, dict) else None

    def do_POST(self):
        if self.path == "/printer/upload":
            return self._printer_upload()
        if self.path != "/slice":
            return self._send(404, {"error": "not found"})
        req = self._body()
        if req is None:
            return self._send(400, {"error": "bad body"})

        quote_id, file_id = str(req.get("quoteId", "")), str(req.get("fileId", ""))
        if not ULID.match(quote_id) or not ULID.match(file_id):
            return self._send(400, {"error": "invalid id"})
        path = os.path.realpath(str(req.get("path", "")))
        if not path.startswith(UPLOADS_DIR + os.sep) or not os.path.isfile(path):
            return self._send(400, {"error": "invalid path"})
        answers = [
            {"label": str(a.get("label", ""))[:200], "value": str(a.get("value", ""))[:2000]}
            for a in (req.get("answers") or [])[:50] if isinstance(a, dict)
        ]

        layout = req.get("layout")
        if layout is not None:
            try:
                layout = {
                    "arrange": bool(layout.get("arrange")),
                    "objects": [
                        {"index": int(o["index"]), "matrix": [float(v) for v in o["matrix"]]}
                        for o in layout["objects"][:500]
                    ],
                }
                if any(len(o["matrix"]) != 16 for o in layout["objects"]):
                    raise ValueError
            except (AttributeError, KeyError, TypeError, ValueError):
                return self._send(400, {"error": "invalid layout"})

        choose = req.get("choose")
        if choose is not None:
            if (not isinstance(choose, dict) or not choose or len(choose) > 500
                    or not all(isinstance(k, str) and CHOOSE_KEY.match(k) and isinstance(v, str) and CHOOSE_VAL.match(v)
                               for k, v in choose.items())):
                return self._send(400, {"error": "invalid choose"})

        if not _lock.acquire(blocking=False):
            return self._send(409, {"error": "busy"})
        try:
            result = pipeline.process({
                "path": path,
                "out_dir": os.path.join(SLICES_DIR, quote_id, file_id),
                "filename": str(req.get("filename", "model"))[:200],
                "answers": answers,
                "use_llm": bool(req.get("useLlm", True)),
                "layout": layout,
                "choose": choose,
            })
        finally:
            _lock.release()
        self._send(200, result)

    def _printer_upload(self):
        if not printer.configured():
            return self._send(503, {"error": "printer not configured"})
        req = self._body()
        if req is None:
            return self._send(400, {"error": "bad body"})
        quote_id, file_id = str(req.get("quoteId", "")), str(req.get("fileId", ""))
        name = str(req.get("name", "")).strip()
        if not ULID.match(quote_id) or not ULID.match(file_id):
            return self._send(400, {"error": "invalid id"})
        if not PRINT_FILE.match(str(req.get("file", ""))):
            return self._send(400, {"error": "invalid file"})
        if not name.endswith(".gcode.3mf") or len(name) > 120 or BAD_NAME.search(name):
            return self._send(400, {"error": "invalid name"})
        local = os.path.join(SLICES_DIR, quote_id, file_id, req["file"])
        if not os.path.isfile(local):
            return self._send(404, {"error": "sliced file not found"})
        if not _upload_lock.acquire(blocking=False):
            return self._send(409, {"error": "busy"})
        try:
            size = printer.upload(local, name)
        except Exception as e:  # report FTP/TLS errors to the app
            return self._send(502, {"error": f"upload failed: {type(e).__name__}: {e}"})
        finally:
            _upload_lock.release()
        local_size = os.path.getsize(local)
        if size is not None and size != local_size:
            return self._send(502, {"error": f"size mismatch on printer ({size} != {local_size})"})
        self._send(200, {"filepath": name, "size": local_size})

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main():
    port = int(os.environ.get("PORT", "8000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
