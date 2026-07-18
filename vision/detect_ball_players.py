"""
Track players (stable numbers) AND the basketball in a broadcast clip.

- Players: YOLO11 + ByteTrack (tuned buffer) -> each player keeps a stable #id,
  with a court filter (hardwood under feet) that drops bench/crowd.
- Ball:    high-res low-conf 'sports ball' detection fused with a constant-
  velocity motion model:
    * candidates are gated by distance to the predicted position (so a shot
      arcing into the upper frame is kept, while crowd false-positives far
      from the trajectory are rejected)
    * when detection misses, the marker extrapolates along its velocity
      (damped) instead of freezing -> passes stay smooth
    * if the full-frame pass finds nothing, a zoomed re-detect runs on a
      crop around the predicted position (catches the small fast ball)

Usage:
  python detect_ball_players.py IN.mov OUT.mp4 [options, see --help]
"""
import argparse
from collections import deque
import cv2
from ultralytics import YOLO

ap = argparse.ArgumentParser()
ap.add_argument("input"); ap.add_argument("output")
ap.add_argument("--model", default="yolo11x.pt")
ap.add_argument("--conf", type=float, default=0.30)      # player conf
ap.add_argument("--min-h", type=float, default=0.05)     # drop tiny distant boxes
ap.add_argument("--tall-h", type=float, default=0.28)    # always keep boxes taller than this (foreground)
ap.add_argument("--wood-frac", type=float, default=0.40) # min fraction of hardwood px under feet to count as on-court
ap.add_argument("--ball-conf", type=float, default=0.08) # ball conf (low: it's tiny)
ap.add_argument("--ball-imgsz", type=int, default=1280)
ap.add_argument("--ball-hold", type=int, default=18)     # frames to extrapolate a lost ball
ap.add_argument("--ball-max-h", type=float, default=0.06)# reject "balls" bigger than this (heads etc)
ap.add_argument("--acq-conf", type=float, default=0.25)  # conf needed to (re)acquire with no track
ap.add_argument("--gate", type=float, default=90.0)      # px gate radius at 1-frame gap (grows with gap)
args = ap.parse_args()

player_model = YOLO(args.model)   # own tracker state
ball_model = YOLO(args.model)     # separate instance so plain predict() can't reset the tracker

cap = cv2.VideoCapture(args.input)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
FPS = cap.get(cv2.CAP_PROP_FPS) or 30
N = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"video: {W}x{H} @ {FPS:.1f}fps, {N} frames", flush=True)

writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
min_h_px = args.min_h * H
tall_h_px = args.tall_h * H
ball_max_h_px = args.ball_max_h * H


def on_court(hsv, cx, feet_y):
    """True if the floor just under (cx, feet_y) is hardwood-colored.

    Bench/crowd sit on the red apron or in the stands, so this cheaply
    separates on-court players (+refs) from everyone else and tracks the
    camera automatically."""
    x0, x1 = max(0, int(cx - 14)), min(W, int(cx + 14))
    y0, y1 = min(H - 1, int(feet_y)), min(H, int(feet_y + 12))
    patch = hsv[y0:y1, x0:x1]
    if patch.size == 0:
        return False
    h, s, v = patch[..., 0], patch[..., 1], patch[..., 2]
    wood = (h >= 10) & (h <= 30) & (s >= 40) & (s <= 180) & (v >= 120)
    return wood.mean() > args.wood_frac


def ball_candidates(result, ox=0, oy=0):
    """Yield (conf, cx, cy) from a YOLO result, offset back to frame coords."""
    if result.boxes is None:
        return
    for b in result.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        if (y2 - y1) > ball_max_h_px:          # too big to be the ball
            continue
        yield float(b.conf[0]), ox + (x1 + x2) / 2, oy + (y1 + y2) / 2


# ---- ball motion state ----
last_ball = None                  # (x, y) last marker position (real or predicted)
last_real = None                  # (x, y) last REAL detection
vel = (0.0, 0.0)                  # px/frame, smoothed from real detections
lost = 0                          # frames since a real detection
trail = deque(maxlen=14)
uniq_ids = set()
frame_i = 0

while True:
    ok, frame = cap.read()
    if not ok:
        break

    # ---- players (tracked, stable ids) ----
    pr = player_model.track(frame, classes=[0], conf=args.conf, persist=True,
                            tracker="tracker_stable.yaml", imgsz=960, verbose=False)[0]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    count = 0
    if pr.boxes is not None:
        for b in pr.boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            bh = y2 - y1
            if bh < min_h_px:
                continue
            # court filter: feet on hardwood, or clearly-foreground tall box
            if bh < tall_h_px and not on_court(hsv, (x1 + x2) / 2, y2):
                continue
            count += 1
            tid = int(b.id[0]) if b.id is not None else -1
            if tid >= 0:
                uniq_ids.add(tid)
            cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
            lbl = f"P{tid}" if tid >= 0 else "P?"
            cv2.putText(frame, lbl, (int(x1), int(y1) - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2, cv2.LINE_AA)

    # ---- ball: predict -> detect -> gate ----
    pred = None
    if last_ball is not None:
        damp = 0.92 ** lost
        pred = (last_ball[0] + vel[0] * damp, last_ball[1] + vel[1] * damp)

    br = ball_model.predict(frame, classes=[32], conf=args.ball_conf,
                            imgsz=args.ball_imgsz, verbose=False)[0]
    cands = list(ball_candidates(br))

    # zoomed re-detect around the prediction if the full-frame pass missed
    if not cands and pred is not None:
        cx, cy = pred
        x0, y0 = max(0, int(cx - 180)), max(0, int(cy - 180))
        x1, y1 = min(W, int(cx + 180)), min(H, int(cy + 180))
        if x1 - x0 > 60 and y1 - y0 > 60:
            crop = frame[y0:y1, x0:x1]
            rr = ball_model.predict(crop, classes=[32], conf=args.ball_conf * 0.8,
                                    imgsz=640, verbose=False)[0]
            cands = list(ball_candidates(rr, ox=x0, oy=y0))

    best = None
    gate = args.gate * (1 + 0.5 * lost)        # gate grows as the gap grows
    for c, cx, cy in cands:
        if pred is not None:
            d = ((cx - pred[0]) ** 2 + (cy - pred[1]) ** 2) ** 0.5
            if d > gate and c < 0.45:          # far off-trajectory + not confident -> reject
                continue
            score = c + 0.3 * max(0.0, 1 - d / gate)
        else:
            # acquisition: no track -> demand confidence, skip top crowd band
            if c < args.acq_conf or cy < 0.12 * H:
                continue
            score = c
        if best is None or score > best[0]:
            best = (score, (cx, cy))

    ball_pt = None; ball_real = False
    if best is not None:
        ball_pt = best[1]; ball_real = True
        if last_real is not None:
            gap = max(1, lost + 1)
            nvx = (ball_pt[0] - last_real[0]) / gap
            nvy = (ball_pt[1] - last_real[1]) / gap
            vel = (0.6 * nvx + 0.4 * vel[0], 0.6 * nvy + 0.4 * vel[1])
        last_real = ball_pt
        last_ball = ball_pt
        lost = 0
    elif pred is not None and lost < args.ball_hold:
        ball_pt = pred                          # extrapolate along velocity
        last_ball = pred
        lost += 1
    else:
        last_ball = None; last_real = None; vel = (0.0, 0.0)
        lost = 0
        trail.clear()

    if ball_pt is not None:
        trail.append((int(ball_pt[0]), int(ball_pt[1])))
        col = (0, 140, 255)                    # orange (BGR)
        for k in range(1, len(trail)):
            (ax, ay), (bx, by) = trail[k - 1], trail[k]
            if abs(ax - bx) > 110 or abs(ay - by) > 110:   # skip teleport segments
                continue
            cv2.line(frame, (ax, ay), (bx, by), col, 2, cv2.LINE_AA)
        r = 12 if ball_real else 9
        cv2.circle(frame, (int(ball_pt[0]), int(ball_pt[1])), r, col, 3, cv2.LINE_AA)
        tag = "BALL" if ball_real else "BALL?"
        cv2.putText(frame, tag, (int(ball_pt[0]) + 14, int(ball_pt[1]) - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, col, 2, cv2.LINE_AA)

    # ---- HUD ----
    cv2.rectangle(frame, (0, 0), (420, 34), (0, 0, 0), -1)
    bs = "yes" if ball_real else ("held" if ball_pt is not None else "--")
    cv2.putText(frame, f"players: {count}   ball: {bs}", (8, 24),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2, cv2.LINE_AA)

    writer.write(frame)
    frame_i += 1
    if frame_i % 60 == 0:
        print(f"  frame {frame_i}/{N}  players={count} ball={bs}", flush=True)

writer.release(); cap.release()
print(f"done. {frame_i} frames, {len(uniq_ids)} unique player ids. wrote {args.output}", flush=True)
