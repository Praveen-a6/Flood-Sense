"""One-command launcher:  python run.py

Starts the FloodSense server on http://localhost:8000 and opens your browser.
Options:  python run.py --port 8080 --no-browser
"""
import argparse
import socket
import threading
import webbrowser

import uvicorn


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    url = f"http://localhost:{args.port}"
    print(f"\n  FloodSense running at  {url}")
    print(f"  Same Wi-Fi phone:      http://{lan_ip()}:{args.port}  (GPS + offline need HTTPS there, see README)\n")
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run("backend.main:app", host="0.0.0.0", port=args.port, log_level="info")
