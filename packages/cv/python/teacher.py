#!/usr/bin/env python3
"""Teacher: heavy offline auto-labeler.

Detects all object classes it can, assigns persistent trackingIds (ByteTrack),
computes velocities, and proposes events via heuristics so the human corrects
instead of labeling from scratch.

Two modes:
- Fine-tuned weights (--weights, trained on our 6 classes): detect+track all
  classes directly. rim/backboard/net/court detected once then propagated.
- COCO fallback (first runs, before any training): yolo11x/yolov8x pretrained.
  person -> player (tracked), sports ball -> ball (velocity-gated like
  vision/track_game.py). rim/backboard/net/court start empty — the human
  labels them once and the first training run teaches them.

Output JSON = TeacherResult (packages/types).

Usage:
  teacher.py VIDEO OUT_JSON [--weights w.pt] [--model yolo11x.pt]
             [--max-frames N] [--stride 1]
"""
import argparse, json, math, os, sys

import cv2
import numpy as np
from ultralytics import YOLO

from classes import CLASSES, COCO_PERSON, COCO_SPORTS_BALL

HERE = os.path.dirname(os.path.abspath(__file__))
TRACKER = os.path.join(HERE, "tracker.yaml")

# ---- event heuristic constants (adapted from vision/derive_events.py) ----
GRAB_PX = 46          # ball within this of a player box => "in hand"
POSSESS_CONFIRM = 4   # consecutive frames to confirm possession
SHOT_UP_VY = -5.0     # px/frame upward (y negative) to call a release
BLOCK_WINDOW = 10     # frames after release a block can occur
REBOUND_WINDOW_S = 3.0
ASSIST_WINDOW_S = 3.0
PASS_MAX_GAP_S = 1.4


def box_dist(px, py, box):
    x1, y1, x2, y2 = box
    dx = max(x1 - px, 0, px - x2)
    dy = max(y1 - py, 0, py - y2)
    return math.hypot(dx, dy)


def obj(cls, x1, y1, x2, y2, tid=None, conf=None, vx=None, vy=None):
    return {
        "id": f"{cls}-{tid if tid is not None else 0}",
        "cls": cls,
        "trackingId": int(tid) if tid is not None else None,
        "x": float(x1), "y": float(y1),
        "w": float(x2 - x1), "h": float(y2 - y1),
        "occluded": False, "blurry": False, "visible": True,
        "vx": vx, "vy": vy,
        "jerseyNumber": None,
        "confidence": float(conf) if conf is not None else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out_json")
    ap.add_argument("--weights", default=None, help="fine-tuned 6-class weights")
    ap.add_argument("--model", default="yolo11x.pt", help="COCO fallback model")
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--conf", type=float, default=0.30)
    ap.add_argument("--ball-conf", type=float, default=0.08)
    ap.add_argument("--ball-imgsz", type=int, default=1280)
    args = ap.parse_args()

    finetuned = bool(args.weights and os.path.exists(args.weights))
    model = YOLO(args.weights if finetuned else args.model)
    ball_model = model if finetuned else YOLO(args.model)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit(f"cannot open {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    frames_out = []
    # per-track last centers for velocity
    last_center = {}   # tid -> (f, cx, cy)
    ball_track = []    # (f, cx, cy, vx, vy) — ball path for event logic
    ball_state = None  # (cx, cy, vx, vy) constant-velocity model
    ball_miss = 0
    static_objs = {}   # cls -> obj, for rim/backboard/net/court propagation (fine-tuned)

    f = -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        f += 1
        if args.max_frames and f >= args.max_frames:
            break
        if f % args.stride:
            continue

        objects = []

        if finetuned:
            res = model.track(frame, conf=args.conf, persist=True,
                              tracker=TRACKER, imgsz=960, verbose=False)[0]
            names = res.names
            for b in (res.boxes or []):
                cls_name = names[int(b.cls[0])]
                if cls_name not in CLASSES:
                    continue
                tid = int(b.id[0]) if b.id is not None else None
                x1, y1, x2, y2 = map(float, b.xyxy[0])
                conf = float(b.conf[0])
                o = obj(cls_name, x1, y1, x2, y2, tid, conf)
                if cls_name in ("rim", "backboard", "net", "court"):
                    static_objs[cls_name] = o
                objects.append(o)
            # propagate static structures through frames where detection dropped
            present = {o["cls"] for o in objects}
            for cls_name, o in static_objs.items():
                if cls_name not in present:
                    objects.append({**o, "occluded": True, "confidence": 0.2})
        else:
            # players: tracked persons
            res = model.track(frame, classes=[COCO_PERSON], conf=args.conf,
                              persist=True, tracker=TRACKER, imgsz=960,
                              verbose=False)[0]
            for b in (res.boxes or []):
                if b.id is None:
                    continue
                tid = int(b.id[0])
                x1, y1, x2, y2 = map(float, b.xyxy[0])
                objects.append(obj("player", x1, y1, x2, y2, tid, float(b.conf[0])))

            # ball: low-conf high-res predict + constant-velocity gating
            bres = ball_model.predict(frame, classes=[COCO_SPORTS_BALL],
                                      conf=args.ball_conf, imgsz=args.ball_imgsz,
                                      verbose=False)[0]
            cands = []
            for b in (bres.boxes or []):
                x1, y1, x2, y2 = map(float, b.xyxy[0])
                if (y2 - y1) > 0.06 * H:
                    continue
                cands.append((float(b.conf[0]), x1, y1, x2, y2))
            pick = None
            if cands:
                if ball_state is None:
                    pick = max(cands)
                else:
                    px = ball_state[0] + ball_state[2]
                    py = ball_state[1] + ball_state[3]
                    gated = [(c, x1, y1, x2, y2) for c, x1, y1, x2, y2 in cands
                             if math.hypot((x1 + x2) / 2 - px, (y1 + y2) / 2 - py) < 110]
                    pick = max(gated) if gated else None
            if pick:
                c, x1, y1, x2, y2 = pick
                cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
                if ball_state is None:
                    vx = vy = 0.0
                else:
                    vx = 0.6 * (cx - ball_state[0]) + 0.4 * ball_state[2]
                    vy = 0.6 * (cy - ball_state[1]) + 0.4 * ball_state[3]
                ball_state, ball_miss = (cx, cy, vx, vy), 0
                objects.append(obj("ball", x1, y1, x2, y2, 1, c, vx, vy))
            elif ball_state is not None and ball_miss < 24:
                cx = ball_state[0] + ball_state[2]
                cy = ball_state[1] + ball_state[3]
                ball_state = (cx, cy, ball_state[2], ball_state[3])
                ball_miss += 1
                o = obj("ball", cx - 12, cy - 12, cx + 12, cy + 12, 1, 0.15,
                        ball_state[2], ball_state[3])
                o["occluded"] = True
                objects.append(o)
            elif ball_miss >= 24:
                ball_state = None

        # velocities for tracked objects
        for o in objects:
            tid = o["trackingId"]
            if tid is None or o["cls"] == "court":
                continue
            key = (o["cls"], tid)
            cx, cy = o["x"] + o["w"] / 2, o["y"] + o["h"] / 2
            if key in last_center:
                lf, lx, ly = last_center[key]
                if f > lf:
                    o["vx"] = (cx - lx) / (f - lf)
                    o["vy"] = (cy - ly) / (f - lf)
            last_center[key] = (f, cx, cy)
            if o["cls"] == "ball":
                ball_track.append((f, cx, cy, o["vx"] or 0.0, o["vy"] or 0.0))

        frames_out.append({"frameNumber": f, "objects": objects})
        if f % 100 == 0:
            print(f"frame {f}/{total}", file=sys.stderr, flush=True)

    cap.release()

    # ---------------- event proposals ----------------
    by_frame = {fr["frameNumber"]: fr["objects"] for fr in frames_out}
    rim_box = None
    for fr in frames_out:
        for o in fr["objects"]:
            if o["cls"] == "rim":
                rim_box = (o["x"], o["y"], o["x"] + o["w"], o["y"] + o["h"])

    def players_at(fi):
        return [o for o in by_frame.get(fi, []) if o["cls"].startswith("player")]

    # possession segments: (startF, endF, tid)
    possessions = []
    cur, streak = None, 0
    for (fi, cx, cy, vx, vy) in ball_track:
        near = None
        best = GRAB_PX
        for p in players_at(fi):
            d = box_dist(cx, cy, (p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]))
            if d < best:
                best, near = d, p["trackingId"]
        if near is not None and (cur is None or cur[2] == near):
            streak += 1
            if cur is None and streak >= POSSESS_CONFIRM:
                possessions.append([fi - POSSESS_CONFIRM + 1, fi, near])
                cur = possessions[-1]
            elif cur is not None:
                cur[1] = fi
        elif near is not None:
            streak = 1
            cur = None
        else:
            streak = 0
            if cur is not None:
                cur = None

    events = []

    def ball_at(fi):
        for (bf, cx, cy, vx, vy) in ball_track:
            if bf == fi:
                return (cx, cy, vx, vy)
        return None

    # shots: possession ends + strong upward ball velocity shortly after
    shots = []
    last_rel = -999
    for i, (s, e, tid) in enumerate(possessions):
        rel = None
        for (bf, cx, cy, vx, vy) in ball_track:
            if e < bf <= e + 8 and vy < SHOT_UP_VY:
                rel = bf
                break
        if rel is None or rel - last_rel < 12:  # split possessions -> same release
            continue
        last_rel = rel
        apex = None
        end = rel
        for (bf, cx, cy, vx, vy) in ball_track:
            if bf > rel and apex is None and vy >= 0:
                apex = bf
            if rel < bf <= rel + int(3.5 * fps):
                end = bf
        result, res_conf = "miss", 0.3
        if rim_box:
            rx = (rim_box[0] + rim_box[2]) / 2
            for (bf, cx, cy, vx, vy) in ball_track:
                if apex and bf > apex and rim_box[1] <= cy <= rim_box[3] and abs(cx - rx) < (rim_box[2] - rim_box[0]) / 2 and vy > 0:
                    result, res_conf = "make", 0.6
        ba = ball_at(rel)
        feat = {
            "vx": ba[2] if ba else None, "vy": ba[3] if ba else None,
            "wrist_y": None, "elbow_y": None,  # no pose model yet
            "ball_in_hand_dist": None,
        }
        payload = {
            "gatherFrame": s, "releaseFrame": rel,
            "apexFrame": apex, "endFrame": end,
            "result": result, "shotType": "2pt",
            "shooterTrackingId": tid,
        }
        events.append({"type": "shot", "keyFrame": rel, "payload": payload,
                       "confidence": min(0.6, res_conf + 0.2), "features": feat})
        shots.append((rel, end, tid, i))

        # block: another player's box overlapping ball just after release
        for (bf, cx, cy, vx, vy) in ball_track:
            if rel < bf <= rel + BLOCK_WINDOW:
                for p in players_at(bf):
                    if p["trackingId"] == tid:
                        continue
                    if box_dist(cx, cy, (p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"])) < 8 and vy > 0:
                        events.append({"type": "block", "keyFrame": bf,
                                       "payload": {"blockFrame": bf,
                                                   "blockerTrackingId": p["trackingId"],
                                                   "shooterTrackingId": tid},
                                       "confidence": 0.3,
                                       "features": {"vx": vx, "vy": vy, "wrist_y": None,
                                                    "elbow_y": None, "ball_in_hand_dist": 0}})
                        break

    # rebounds: shot end -> next possession within window
    for (rel, end, tid, pi) in shots:
        nxt = next((p for p in possessions if p[0] > end and (p[0] - end) / fps < REBOUND_WINDOW_S), None)
        if nxt:
            events.append({"type": "rebound", "keyFrame": nxt[0],
                           "payload": {"startFrame": end, "endFrame": nxt[0],
                                       "rebounderTrackingId": nxt[2],
                                       "reboundType": "defensive"},
                           "confidence": 0.4, "features": None})

    # possession changes + steal proposals (no shot between the two possessions)
    shot_rels = [r for (r, *_rest) in shots]
    for a, b in zip(possessions, possessions[1:]):
        if a[2] == b[2]:
            continue
        gap_s = (b[0] - a[1]) / fps
        events.append({"type": "possession_change", "keyFrame": b[0],
                       "payload": {"fromTrackingId": a[2], "toTrackingId": b[2]},
                       "confidence": 0.5, "features": None})
        shot_between = any(a[1] <= r <= b[0] for r in shot_rels)
        if not shot_between and gap_s < 1.0:
            events.append({"type": "steal", "keyFrame": b[0],
                           "payload": {"stealFrame": b[0], "stealerTrackingId": b[2],
                                       "loserTrackingId": a[2]},
                           "confidence": 0.25, "features": None})

    # assists: pass (possession a -> b) followed by b's made shot within window
    for a, b in zip(possessions, possessions[1:]):
        if a[2] == b[2] or (b[0] - a[1]) / fps > PASS_MAX_GAP_S:
            continue
        mk = next((ev for ev in events if ev["type"] == "shot"
                   and ev["payload"]["shooterTrackingId"] == b[2]
                   and 0 <= (ev["keyFrame"] - b[0]) / fps <= ASSIST_WINDOW_S
                   and ev["payload"]["result"] == "make"), None)
        if mk:
            events.append({"type": "assist", "keyFrame": a[1],
                           "payload": {"passFrame": a[1],
                                       "shotReleaseFrame": mk["keyFrame"],
                                       "assisterTrackingId": a[2],
                                       "shooterTrackingId": b[2]},
                           "confidence": 0.35, "features": None})

    out = {"fps": fps, "width": W, "height": H, "frameCount": f + 1,
           "frames": frames_out, "events": sorted(events, key=lambda e: e["keyFrame"])}
    with open(args.out_json, "w") as fh:
        json.dump(out, fh)
    print(json.dumps({"frames": len(frames_out), "events": len(events),
                      "finetuned": finetuned}))


if __name__ == "__main__":
    main()
