#!/usr/bin/env python3
"""Student: fast per-frame detector serving the real-time pipeline.

Loads the current *production* student weights straight from the shared
SQLite DB (no API between apps — DB is the contract). Before any training
has run it falls back to COCO yolo11n (person->player, sports ball->ball)
so /live works on day one, weak but real.

Modes:
  websocket (default): ws://localhost:8765 — binary JPEG in, JSON detections out.
  --stdio: one base64-JPEG per line on stdin, one JSON line out (predictStudent()).

Reload: send text message "reload" (ws) — re-reads DB and hot-swaps weights,
so every promoted training run immediately upgrades live tracking.
"""
import argparse, base64, json, os, sqlite3, sys

import cv2
import numpy as np
from ultralytics import YOLO

from classes import CLASSES, COCO_PERSON, COCO_SPORTS_BALL

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "../../.."))
DB = os.path.join(REPO, "data", "ball.db")


def production_model():
    """(weightsPath, modelVersionId) from DB, else COCO fallback."""
    if os.path.exists(DB):
        con = sqlite3.connect(DB)
        try:
            for status in ("production", "ready"):
                row = con.execute(
                    "SELECT weightsPath, id FROM ModelVersion "
                    "WHERE type='student' AND status=? ORDER BY version DESC LIMIT 1",
                    (status,),
                ).fetchone()
                if row and os.path.exists(row[0]):
                    return row[0], row[1]
        finally:
            con.close()
    return "yolo11n.pt", "coco-pretrained-fallback"


class Student:
    def __init__(self):
        self.load()

    def load(self):
        self.weights, self.model_version = production_model()
        self.model = YOLO(self.weights)
        self.finetuned = "coco" not in self.model_version
        print(f"student weights: {self.weights} ({self.model_version})",
              file=sys.stderr, flush=True)

    def detect(self, frame):
        if self.finetuned:
            res = self.model.predict(frame, conf=0.25, imgsz=640, verbose=False)[0]
            names = res.names
            dets = []
            for b in (res.boxes or []):
                cls = names[int(b.cls[0])]
                if cls not in CLASSES:
                    continue
                x1, y1, x2, y2 = map(float, b.xyxy[0])
                dets.append({"cls": cls, "x": x1, "y": y1, "w": x2 - x1,
                             "h": y2 - y1, "confidence": float(b.conf[0]),
                             "trackingId": None})
        else:
            res = self.model.predict(frame, classes=[COCO_PERSON, COCO_SPORTS_BALL],
                                     conf=0.2, imgsz=640, verbose=False)[0]
            dets = []
            for b in (res.boxes or []):
                cid = int(b.cls[0])
                cls = "player" if cid == COCO_PERSON else "ball"
                x1, y1, x2, y2 = map(float, b.xyxy[0])
                dets.append({"cls": cls, "x": x1, "y": y1, "w": x2 - x1,
                             "h": y2 - y1, "confidence": float(b.conf[0]),
                             "trackingId": None})
        return dets


def run_stdio(student):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "reload":
            student.load()
            continue
        img = cv2.imdecode(np.frombuffer(base64.b64decode(line), np.uint8),
                           cv2.IMREAD_COLOR)
        dets = student.detect(img) if img is not None else []
        print(json.dumps({"modelVersion": student.model_version,
                          "detections": dets}), flush=True)


async def run_ws(student, port):
    import asyncio
    import websockets

    async def handler(ws):
        async for msg in ws:
            if isinstance(msg, str):
                if msg == "reload":
                    student.load()
                    await ws.send(json.dumps({"reloaded": student.model_version}))
                continue
            img = cv2.imdecode(np.frombuffer(msg, np.uint8), cv2.IMREAD_COLOR)
            dets = student.detect(img) if img is not None else []
            await ws.send(json.dumps({"modelVersion": student.model_version,
                                      "detections": dets}))

    async with __import__("websockets").serve(handler, "localhost", port,
                                              max_size=8 * 1024 * 1024):
        print(f"student server ws://localhost:{port}", file=sys.stderr, flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stdio", action="store_true")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    s = Student()
    if args.stdio:
        run_stdio(s)
    else:
        import asyncio
        asyncio.run(run_ws(s, args.port))
