"""Dummy ESP32 node: behaves like a real device on the network.

It POSTs JSON to /api/ingest with the X-Device-Key header every few seconds, exactly
what the Arduino sketch in the README does, so the API cannot tell it apart from
hardware. Standard library only.

    python tools/dummy_esp32.py                                   # API on this PC
    python tools/dummy_esp32.py --url http://10.7.209.43:8000/api/ingest
    python tools/dummy_esp32.py --breach-every 12                 # strain alert every 12th reading

The device key comes from --key (your personal key from the website, so the node shows up
on your own dashboard), SHM_DEVICE_KEY, or else backend/.env (a DEVICE_KEYS entry for this
node, then DEVICE_SHARED_KEY). Stop with Ctrl+C.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / "backend" / ".env"

# Normal level, noise, safe limit and decimals for the three sensors (HX711 strain,
# ADXL345 vibration, DS18B20 temperature); limits match the API defaults.
SENSORS = {
    "strain": (320.0, 9.0, 620.0, 1),
    "vibration": (0.6, 0.05, 1.8, 3),
    "temperature": (27.0, 0.25, 42.0, 1),
}


def device_key(node_id: str) -> str:
    if os.environ.get("SHM_DEVICE_KEY"):
        return os.environ["SHM_DEVICE_KEY"]
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    for pair in env.get("DEVICE_KEYS", "").split(","):
        if ":" in pair:
            node, key = pair.split(":", 1)
            if node.strip().upper() == node_id.upper() and key.strip():
                return key.strip()
    if env.get("DEVICE_SHARED_KEY"):
        return env["DEVICE_SHARED_KEY"]
    sys.exit("No device key: set SHM_DEVICE_KEY or DEVICE_SHARED_KEY in backend/.env")


class Node:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.level = {p: base for p, (base, *_rest) in SENSORS.items()}
        self.battery = rng.uniform(85, 100)

    def readings(self, breach: bool) -> dict[str, float]:
        out = {}
        for p, (base, noise, safe, decimals) in SENSORS.items():
            # Mean-reverting walk, so values wander a little but never jump.
            self.level[p] += 0.25 * (base - self.level[p]) + self.rng.gauss(0, noise)
            value = self.level[p]
            if breach and p == "strain":
                value = safe * self.rng.uniform(1.05, 1.3)
            out[p] = round(max(0.0, value), decimals)
        self.battery = max(5.0, self.battery - self.rng.uniform(0, 0.02))
        return out


def post(url: str, key: str, payload: dict, timeout: float) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Device-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as err:
        try:
            body = json.loads(err.read() or b"{}")
        except ValueError:
            body = {}
        return err.code, body


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:8000/api/ingest")
    ap.add_argument("--node", default="ESP32-DUMMY", help="node_id (letters, digits, - or _, max 32)")
    ap.add_argument("--key", help="device key; use your personal key from the website's Connect your ESP32 card")
    ap.add_argument("--location", default="Ground floor - test bench (dummy node)",
                    help='where the node is; start with the floor, e.g. "3rd floor - column C2" or "Roof - tank frame"')
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between readings")
    ap.add_argument("--breach-every", type=int, default=0, metavar="N",
                    help="send a strain reading over the limit every Nth message (0 = never)")
    ap.add_argument("--count", type=int, default=0, help="stop after this many messages (0 = run forever)")
    args = ap.parse_args()

    key = args.key or device_key(args.node)
    node = Node(random.Random())
    print(f"Dummy node {args.node} -> {args.url} every {args.interval:g}s (Ctrl+C to stop)", flush=True)
    sent = 0
    try:
        while True:
            sent += 1
            breach = args.breach_every > 0 and sent % args.breach_every == 0
            payload = {
                "node_id": args.node, "location": args.location, "readings": node.readings(breach),
                "battery": round(node.battery, 1), "rssi": max(-100, min(-30, int(node.rng.gauss(-58, 5)))),
                "firmware": "dummy-1.0",
            }
            values = " ".join(f"{p}={v}" for p, v in payload["readings"].items())
            try:
                status, body = post(args.url, key, payload, timeout=max(3.0, args.interval))
            except (urllib.error.URLError, OSError) as err:
                print(f"#{sent} cannot reach API: {getattr(err, 'reason', err)}", flush=True)
            else:
                if status == 200:
                    alert = "  ALERT" if body.get("alert_triggered") else ""
                    print(f"#{sent} 200 {values}{alert}", flush=True)
                else:
                    print(f"#{sent} HTTP {status}: {body.get('detail', body)}", flush=True)
            if args.count and sent >= args.count:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
