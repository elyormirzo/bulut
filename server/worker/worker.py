"""MatnQil — Bulut: VPS'dagi yordamchi xizmat.

Local Telegram Bot API serveri 2 GB gacha faylni diskka yuklab oladi.
Bu xizmat esa:
  POST /prepare {"file_id": ...}  -> faylni oladi, ffmpeg bilan ovozini ajratadi (opus, ~11 MB/soat)
                                     {"status": "ready"|"pending"|"error", ...}
  GET  /audio/<id>.ogg            -> tayyor ovoz fayli
  GET  /file?file_id=...          -> asl fayl (kichik fayllar uchun)
  GET  /health                    -> "ok" (kalitsiz)
Har bir so'rovda X-Bulut-Key = HMAC-SHA256(bot_token, "bulut-worker-v1") talab qilinadi.
Eski fayllar avtomatik o'chiriladi (disk to'lmasligi uchun).
"""

import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
BOT_API = os.environ.get("BOT_API", "http://bot-api:8081")
KEY = hmac.new(TOKEN.encode(), b"bulut-worker-v1", hashlib.sha256).hexdigest()
DATA = "/var/lib/telegram-bot-api"
OUT = os.environ.get("AUDIO_DIR", "/audio")
WAIT_SEC = float(os.environ.get("PREPARE_WAIT_SEC", "60"))
KEEP_SEC = float(os.environ.get("KEEP_HOURS", "12")) * 3600
PORT = int(os.environ.get("PORT", "8090"))

os.makedirs(OUT, exist_ok=True)
jobs: dict = {}
lock = threading.Lock()


def job_id(file_id: str) -> str:
    return hashlib.sha256(file_id.encode()).hexdigest()[:32]


def get_file(file_id: str) -> str:
    """Local Bot API'dan faylni so'raydi (katta fayl bo'lsa, u yuklab bo'lguncha kutadi)."""
    req = urllib.request.Request(
        f"{BOT_API}/bot{TOKEN}/getFile",
        data=json.dumps({"file_id": file_id}).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=3 * 3600) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        d = json.loads(e.read() or b"{}")
    if not d.get("ok"):
        raise RuntimeError(f"getFile: {d.get('description', 'xato')}")
    path = d["result"].get("file_path", "")
    if not os.path.isabs(path):
        raise RuntimeError("bot-api --local rejimida ishlamayapti")
    real = os.path.realpath(path)
    if not real.startswith(DATA + "/") or not os.path.isfile(real):
        raise RuntimeError("fayl topilmadi")
    return real


def duration(path: str):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=60,
        )
        return round(float(r.stdout.strip()), 2)
    except Exception:
        return None


def run(jid: str, file_id: str):
    job = jobs[jid]
    try:
        src = get_file(file_id)
        out = os.path.join(OUT, jid + ".ogg")
        tmp = out + ".part"
        subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
             "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "16k", "-application", "voip",
             "-f", "ogg", tmp],
            check=True, capture_output=True, timeout=3 * 3600,
        )
        os.replace(tmp, out)
        job.update(status="ready", size=os.path.getsize(out), duration=duration(out))
    except subprocess.CalledProcessError as e:
        job.update(status="error", error="ffmpeg: " + e.stderr.decode(errors="replace")[-300:])
    except Exception as e:  # noqa: BLE001
        job.update(status="error", error=str(e)[:300])
    finally:
        job["event"].set()
        print(f"prepare {jid}: {job['status']} {job.get('error', '')}", flush=True)


def prepare(file_id: str) -> dict:
    jid = job_id(file_id)
    with lock:
        job = jobs.get(jid)
        if job is None or (job["status"] == "error" and job.get("seen")):
            out = os.path.join(OUT, jid + ".ogg")
            if os.path.isfile(out):  # xizmat qayta ishga tushgan bo'lsa ham tayyor fayl saqlanadi
                job = {"status": "ready", "size": os.path.getsize(out), "duration": duration(out),
                       "event": threading.Event(), "t": time.time()}
                job["event"].set()
                jobs[jid] = job
            else:
                job = {"status": "pending", "event": threading.Event(), "t": time.time()}
                jobs[jid] = job
                threading.Thread(target=run, args=(jid, file_id), daemon=True).start()
    job["event"].wait(WAIT_SEC)
    if job["status"] == "ready":
        return {"status": "ready", "id": jid, "size": job["size"], "duration": job.get("duration")}
    if job["status"] == "error":
        job["seen"] = True  # keyingi so'rov qaytadan urinadi
        return {"status": "error", "error": job.get("error", "")}
    return {"status": "pending"}


def cleanup_loop():
    while True:
        time.sleep(1800)
        cutoff = time.time() - KEEP_SEC
        removed = 0
        # Ovoz fayllari va Bot API yuklagan fayllar (faqat <token>/<tur>/ ichidagilar; bazaga tegmaymiz).
        dirs = [OUT] + [os.path.join(DATA, t, s) for t in os.listdir(DATA) if os.path.isdir(os.path.join(DATA, t))
                        for s in os.listdir(os.path.join(DATA, t)) if os.path.isdir(os.path.join(DATA, t, s))]
        for d in dirs:
            for name in os.listdir(d):
                p = os.path.join(d, name)
                try:
                    if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                        os.remove(p)
                        removed += 1
                except OSError:
                    pass
        with lock:
            for jid in [j for j, v in jobs.items() if v["t"] < cutoff]:
                jobs.pop(jid, None)
        if removed:
            print(f"cleanup: {removed} ta eski fayl o'chirildi", flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # har javobdan keyin ulanish yopiladi

    def log_message(self, fmt, *args):  # tokenli yo'llar logga tushmasin
        pass

    def send_json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: str, ctype: str):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(size))
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 1024 * 1024)

    def authed(self) -> bool:
        if hmac.compare_digest(self.headers.get("x-bulut-key", ""), KEY):
            return True
        self.send_json(401, {"error": "forbidden"})
        return False

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == "/health":
            return self.send_json(200, {"ok": True})
        if not self.authed():
            return
        m = re.fullmatch(r"/audio/([0-9a-f]{32})\.ogg", url.path)
        if m:
            p = os.path.join(OUT, m.group(1) + ".ogg")
            return self.send_file(p, "audio/ogg") if os.path.isfile(p) else self.send_json(404, {"error": "yo'q"})
        if url.path == "/file":
            fid = urllib.parse.parse_qs(url.query).get("file_id", [""])[0]
            try:
                return self.send_file(get_file(fid), "application/octet-stream")
            except Exception as e:  # noqa: BLE001
                return self.send_json(400, {"error": str(e)[:300]})
        self.send_json(404, {"error": "yo'q"})

    def do_POST(self):
        raw = self.rfile.read(min(int(self.headers.get("content-length", "0") or 0), 65536))
        if not self.authed():
            return
        if urllib.parse.urlparse(self.path).path != "/prepare":
            return self.send_json(404, {"error": "yo'q"})
        try:
            body = json.loads(raw or b"{}")
            fid = str(body.get("file_id", ""))
            if not fid:
                return self.send_json(400, {"error": "file_id"})
            self.send_json(200, prepare(fid))
        except Exception as e:  # noqa: BLE001
            self.send_json(500, {"error": str(e)[:300]})


if __name__ == "__main__":
    threading.Thread(target=cleanup_loop, daemon=True).start()
    print(f"worker :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
