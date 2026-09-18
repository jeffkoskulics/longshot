"""Serve the repo, drive the browser test, and exit non-zero if it failed.

Kept in Python because that is what this machine has: no Node, so no headless
browser driver library either. The page posts its own results back to /__result,
which sidesteps having to scrape the DOM out of a headless browser.
"""
import http.server
import os
import subprocess
import sys
import threading
import time

PORT = int(sys.argv[1])
BROWSER = sys.argv[2]
HEADLESS = sys.argv[3] == "1"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

result = {"text": None}
done = threading.Event()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_POST(self):
        if self.path != "/__result":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", 0))
        result["text"] = self.rfile.read(n).decode("utf-8", "replace")
        self.send_response(204)
        self.end_headers()
        done.set()

    def log_message(self, *a):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

url = f"http://127.0.0.1:{PORT}/tests/browser.html?report"
args = [BROWSER, "--no-first-run", "--no-default-browser-check",
        f"--user-data-dir=/tmp/longshot-browsertest-{PORT}", url]
if HEADLESS:
    args[1:1] = ["--headless=new", "--disable-gpu"]

proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

ok = done.wait(timeout=240)
proc.terminate()
try:
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
server.shutdown()

if not ok:
    print("error: the browser never reported a result (timed out)", file=sys.stderr)
    sys.exit(1)

text = result["text"].strip()
print(text)
sys.exit(0 if "ALL PASS" in text else 1)
