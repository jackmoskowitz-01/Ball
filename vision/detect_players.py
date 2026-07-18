"""
Detect all players in a basketball video using YOLO (COCO 'person' class).

Outputs:
  - an annotated .mp4 with a bounding box + track id on every detected person
  - a live on-screen count
Usage:
  python detect_players.py INPUT.mov OUTPUT.mp4 [--conf 0.3] [--min-h 0.03] [--model yolo11x.pt]
"""
import argparse, sys
import cv2
from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("input")
ap.add_argument("output")
ap.add_argument("--model", default="yolo11x.pt")
ap.add_argument("--conf", type=float, default=0.30)
ap.add_argument("--min-h", type=float, default=0.03,
                help="ignore boxes shorter than this fraction of frame height (drops distant crowd)")
args = ap.parse_args()

model = YOLO(args.model)

cap = cv2.VideoCapture(args.input)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
FPS = cap.get(cv2.CAP_PROP_FPS) or 30
N = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
cap.release()
print(f"video: {W}x{H} @ {FPS:.1f}fps, {N} frames", flush=True)

writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
min_h_px = args.min_h * H

# stream=True yields one Results per frame; persist track ids across frames
results = model.track(
    source=args.input, classes=[0], conf=args.conf,
    persist=True, stream=True, tracker="bytetrack.yaml", verbose=False,
)

frame_i = 0
uniq_ids = set()
for r in results:
    frame = r.orig_img.copy()
    count = 0
    if r.boxes is not None:
        for b in r.boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            if (y2 - y1) < min_h_px:
                continue
            count += 1
            tid = int(b.id[0]) if b.id is not None else -1
            if tid >= 0:
                uniq_ids.add(tid)
            cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
            label = f"#{tid}" if tid >= 0 else "person"
            cv2.putText(frame, label, (int(x1), int(y1) - 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)
    banner = f"players/people detected: {count}"
    cv2.rectangle(frame, (0, 0), (360, 34), (0, 0, 0), -1)
    cv2.putText(frame, banner, (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                (0, 255, 255), 2, cv2.LINE_AA)
    writer.write(frame)
    frame_i += 1
    if frame_i % 60 == 0:
        print(f"  frame {frame_i}/{N}  (this frame: {count})", flush=True)

writer.release()
print(f"done. {frame_i} frames, {len(uniq_ids)} unique tracked identities. wrote {args.output}", flush=True)
