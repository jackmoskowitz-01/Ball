#!/usr/bin/env python3
"""
AUTOCODE perception pipeline — track players (real jersey numbers), the ball,
and the basket in broadcast basketball film.

  players : YOLO11 + ByteTrack stable ids + hardwood-under-feet court filter
  jerseys : EasyOCR digit reads on torso crops, confidence-weighted voting
            per track id -> boxes are labeled with REAL jersey numbers (#44)
  ball    : low-conf high-res detection fused with a constant-velocity motion
            model (prediction gating, extrapolation through misses, crop
            re-detects at the prediction AND ahead along the velocity)
  basket  : template tracking of the backboard+rim. Auto-acquired in the first
            frames (orange rim candidates elected by white-net + hardwood
            context + template persistence), or calibrated once with --rim.

Operator quickstart (one game, one command):
  python track_game.py GAME.mp4 GAME_tracked.mp4
Optional one-time rim calibration if auto-acquire misses in your gym:
  python track_game.py GAME.mp4 out.mp4 --rim 312,110,90,95   # x,y,w,h

Output video is written with OpenCV (mp4v). For web/QuickTime playback:
  ffmpeg -i out.mp4 -c:v libx264 -pix_fmt yuv420p -movflags +faststart final.mp4
"""
import argparse
import warnings
from collections import defaultdict, deque

import cv2
import numpy as np

warnings.filterwarnings("ignore")

from ultralytics import YOLO  # noqa: E402

# ---------------------------------------------------------------- args
ap = argparse.ArgumentParser(description=__doc__,
                             formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("input"); ap.add_argument("output")
ap.add_argument("--model", default="yolo11x.pt")
# players
ap.add_argument("--conf", type=float, default=0.30)
ap.add_argument("--min-h", type=float, default=0.05)
ap.add_argument("--tall-h", type=float, default=0.28)
ap.add_argument("--wood-frac", type=float, default=0.40)
# jerseys
ap.add_argument("--no-ocr", action="store_true", help="skip jersey OCR")
ap.add_argument("--ocr-every", type=int, default=3, help="OCR every Nth frame per track")
ap.add_argument("--ocr-min-h", type=float, default=0.12, help="min box height (frac) to attempt OCR")
ap.add_argument("--roster", default=None,
                help="comma-separated valid jersey numbers (e.g. '5,19,33,58'); "
                     "reads not on the roster are discarded — strongly recommended")
# ball
ap.add_argument("--ball-conf", type=float, default=0.08)
ap.add_argument("--ball-imgsz", type=int, default=1536)
ap.add_argument("--ball-hold", type=int, default=24)
ap.add_argument("--ball-max-h", type=float, default=0.06)
ap.add_argument("--acq-conf", type=float, default=0.30)
ap.add_argument("--gate", type=float, default=110.0)
# basket
ap.add_argument("--rim", default=None, help="manual rim calibration 'x,y,w,h' from frame 0")
ap.add_argument("--no-basket", action="store_true")
ap.add_argument("--dump-frame", default=None, metavar="PNG",
                help="write frame 0 to PNG (for reading --rim coordinates) and exit")
args = ap.parse_args()

if args.dump_frame:
    _cap = cv2.VideoCapture(args.input)
    _ok, _f = _cap.read(); _cap.release()
    cv2.imwrite(args.dump_frame, _f)
    print(f"frame 0 written to {args.dump_frame} — find the backboard box "
          f"(x,y,w,h) in an image viewer, then rerun with --rim x,y,w,h")
    raise SystemExit(0)

player_model = YOLO(args.model)
ball_model = YOLO(args.model)

reader = None
if not args.no_ocr:
    import easyocr
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)

cap = cv2.VideoCapture(args.input)
W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)); H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
FPS = cap.get(cv2.CAP_PROP_FPS) or 30
N = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
print(f"video: {W}x{H} @ {FPS:.1f}fps, {N} frames", flush=True)

writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
min_h_px = args.min_h * H
tall_h_px = args.tall_h * H
ball_max_h_px = args.ball_max_h * H

GREEN = (0, 255, 0); ORANGE = (0, 140, 255); YELLOW = (0, 255, 255)


# ---------------------------------------------------------------- court filter
def on_court(hsv, cx, feet_y):
    """True if the floor just under (cx, feet_y) is hardwood-colored."""
    x0, x1 = max(0, int(cx - 14)), min(W, int(cx + 14))
    y0, y1 = min(H - 1, int(feet_y)), min(H, int(feet_y + 12))
    patch = hsv[y0:y1, x0:x1]
    if patch.size == 0:
        return False
    h, s, v = patch[..., 0], patch[..., 1], patch[..., 2]
    wood = (h >= 10) & (h <= 30) & (s >= 40) & (s <= 180) & (v >= 120)
    return wood.mean() > args.wood_frac


def wood_frac_at(hsv, x0, x1, y0, y1):
    x0, x1 = max(0, x0), min(W, x1); y0, y1 = max(0, y0), min(H, y1)
    patch = hsv[y0:y1, x0:x1]
    if patch.size == 0:
        return 0.0
    h, s, v = patch[..., 0], patch[..., 1], patch[..., 2]
    return float(((h >= 10) & (h <= 30) & (s >= 40) & (s <= 180) & (v >= 120)).mean())


# ---------------------------------------------------------------- jersey OCR
jersey_votes = defaultdict(lambda: defaultdict(float))  # tid -> {number: weight}
jersey_reads = defaultdict(int)                          # tid -> read count
jersey_final = {}                                        # tid -> number str
roster = set(x.strip() for x in args.roster.split(",")) if args.roster else None


def jersey_label(tid):
    if tid in jersey_final:
        return "#" + jersey_final[tid]
    votes = jersey_votes[tid]
    if votes:
        num, w = max(votes.items(), key=lambda kv: kv[1])
        # lock in only with real evidence: wrong-number labels are worse
        # for a coaching staff than an anonymous P-id
        if w >= 2.0 and jersey_reads[tid] >= 3:
            jersey_final[tid] = num
            return "#" + num
    return f"P{tid}"


def ocr_jersey(frame, tid, x1, y1, x2, y2):
    """Read digits off the torso band of a player box; add weighted votes."""
    bh = y2 - y1
    ty1, ty2 = int(y1 + bh * 0.15), int(y1 + bh * 0.55)
    crop = frame[max(0, ty1):min(H, ty2), max(0, int(x1)):min(W, int(x2))]
    if crop.size == 0:
        return
    crop = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    for _, text, conf in reader.readtext(crop, allowlist="0123456789", min_size=8):
        if conf < 0.45 or not (1 <= len(text) <= 2):
            continue
        if roster is not None and text not in roster:
            continue                       # misreads to off-roster numbers die here
        jersey_votes[tid][text] += float(conf)
        jersey_reads[tid] += 1


# ---------------------------------------------------------------- basket
rim_tmpl = None          # grayscale template of backboard+rim
rim_pos = None           # (x, y) top-left of last confirmed match
rim_lost = 0
RIM_THRESH = 0.45


def acquire_rim_auto(frames):
    """Best-effort rim election: orange clusters in the upper frame whose
    LOCAL patch persists across ~2s of film (structures stay put; players,
    even slow ones, drift). This is a heuristic — when it isn't confident it
    returns nothing rather than tracking the wrong object. The reliable path
    for a real install is one-time calibration with --rim (see --dump-frame).
    """
    fr0 = frames[0]
    hsv = cv2.cvtColor(fr0, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    mask = (((h <= 22) | (h >= 175)) & (s > 140) & (v > 110)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames[1:]]
    cands = []
    for i in range(1, n):
        x, y, w, hh, area = stats[i]
        # rims live in the upper third of a broadcast frame
        if not (80 < area < 900 and 15 <= w <= 70 and 6 <= hh <= 32 and y < H * 0.32):
            continue
        # above a rim is backboard glass / crowd — never solid red apron/signage
        above = hsv[max(0, y - 2 * hh):y, x:x + w]
        redf = float((((above[..., 0] <= 12) | (above[..., 0] >= 175)) & (above[..., 1] > 120)).mean()) if above.size else 1.0
        if redf > 0.45:
            continue
        px0, py0 = max(0, int(x - 0.6 * w)), max(0, int(y - 2.4 * hh))
        px1, py1 = min(W, int(x + 1.6 * w)), min(H, int(y + 2.6 * hh))
        patch = cv2.cvtColor(fr0[py0:py1, px0:px1], cv2.COLOR_BGR2GRAY)
        if patch.shape[0] < 20 or patch.shape[1] < 20:
            continue
        # persistence within a LOCAL window only — players leave, rims stay
        M = 40; th_, tw_ = patch.shape
        scores = []
        for g in grays:
            wy0, wx0 = max(0, py0 - M), max(0, px0 - M)
            wy1, wx1 = min(H, py0 + th_ + M), min(W, px0 + tw_ + M)
            win = g[wy0:wy1, wx0:wx1]
            if win.shape[0] <= th_ or win.shape[1] <= tw_:
                continue
            scores.append(float(cv2.matchTemplate(win, patch, cv2.TM_CCOEFF_NORMED).max()))
        if scores:
            cands.append((float(np.mean(scores)), (px0, py0, px1 - px0, py1 - py0)))
    cands.sort(reverse=True)
    # demand a confident AND unambiguous winner before trusting it
    if cands and cands[0][0] > 0.85 and (len(cands) == 1 or cands[0][0] - cands[1][0] > 0.1):
        x, y, w, hh = cands[0][1]
        print(f"rim auto-acquired: bbox={cands[0][1]} persist={cands[0][0]:.2f}", flush=True)
        return cv2.cvtColor(fr0[y:y + hh, x:x + w], cv2.COLOR_BGR2GRAY), (x, y)
    print("rim auto-acquire not confident — basket disabled. "
          "Calibrate once with: --dump-frame frame0.png, find the backboard "
          "box in any image viewer, then rerun with --rim x,y,w,h", flush=True)
    return None, None


def track_rim(gray):
    """Match the rim template: local search near last position, global rescan
    when lost. Returns (x, y, score) or None."""
    global rim_pos, rim_lost
    th, tw = rim_tmpl.shape
    if rim_pos is not None and rim_lost < 30:
        m = 120
        x0, y0 = max(0, rim_pos[0] - m), max(0, rim_pos[1] - m)
        x1, y1 = min(W, rim_pos[0] + tw + m), min(H, rim_pos[1] + th + m)
        window = gray[y0:y1, x0:x1]
        if window.shape[0] > th and window.shape[1] > tw:
            res = cv2.matchTemplate(window, rim_tmpl, cv2.TM_CCOEFF_NORMED)
            _, mx, _, loc = cv2.minMaxLoc(res)
            if mx >= RIM_THRESH:
                rim_pos = (x0 + loc[0], y0 + loc[1]); rim_lost = 0
                return (*rim_pos, mx)
    # global rescan (cheap at this size; also handles pans back into frame)
    res = cv2.matchTemplate(gray, rim_tmpl, cv2.TM_CCOEFF_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(res)
    if mx >= RIM_THRESH:
        rim_pos = loc; rim_lost = 0
        return (*rim_pos, mx)
    rim_lost += 1
    return None


# ---------------------------------------------------------------- ball
def ball_candidates(result, ox=0, oy=0):
    if result.boxes is None:
        return
    for b in result.boxes:
        x1, y1, x2, y2 = b.xyxy[0].tolist()
        if (y2 - y1) > ball_max_h_px:
            continue
        yield float(b.conf[0]), ox + (x1 + x2) / 2, oy + (y1 + y2) / 2


def ball_colored(frame, cx, cy):
    """Is the patch at (cx, cy) basketball-colored (dark orange/brown)?"""
    x0, x1 = max(0, int(cx - 5)), min(W, int(cx + 5))
    y0, y1 = max(0, int(cy - 5)), min(H, int(cy + 5))
    patch = frame[y0:y1, x0:x1]
    if patch.size == 0:
        return False
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return float(((h >= 3) & (h <= 24) & (s > 70) & (v > 50) & (v < 220)).mean()) > 0.3


def crop_detect(frame, cx, cy, half=180, conf_scale=0.8):
    x0, y0 = max(0, int(cx - half)), max(0, int(cy - half))
    x1, y1 = min(W, int(cx + half)), min(H, int(cy + half))
    if x1 - x0 < 60 or y1 - y0 < 60:
        return []
    rr = ball_model.predict(frame[y0:y1, x0:x1], classes=[32],
                            conf=args.ball_conf * conf_scale, imgsz=640, verbose=False)[0]
    return list(ball_candidates(rr, ox=x0, oy=y0))


last_ball = None; last_real = None; vel = (0.0, 0.0); lost = 0
trail = deque(maxlen=14)

# ---------------------------------------------------------------- rim init
if not args.no_basket:
    boot = []
    for _ in range(12):
        ok, f = cap.read()
        if not ok:
            break
        boot.append(f)
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    if args.rim:
        x, y, w, hh = [int(t) for t in args.rim.split(",")]
        rim_tmpl = cv2.cvtColor(boot[0][y:y + hh, x:x + w], cv2.COLOR_BGR2GRAY)
        rim_pos = (x, y)
        print(f"rim calibrated from --rim {args.rim}", flush=True)
    elif boot:
        rim_tmpl, rim_pos = acquire_rim_auto(boot)

# ---------------------------------------------------------------- main loop
uniq = set(); frame_i = 0
while True:
    ok, frame = cap.read()
    if not ok:
        break
    raw = frame  # OCR + color checks read from the un-annotated image
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # ---- basket ----
    rim_hit = None
    if rim_tmpl is not None:
        rim_hit = track_rim(gray)

    # ---- players ----
    pr = player_model.track(raw, classes=[0], conf=args.conf, persist=True,
                            tracker="tracker_stable.yaml", imgsz=960, verbose=False)[0]
    boxes = []
    if pr.boxes is not None:
        for b in pr.boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            bh = y2 - y1
            if bh < min_h_px:
                continue
            if bh < tall_h_px and not on_court(hsv, (x1 + x2) / 2, y2):
                continue
            tid = int(b.id[0]) if b.id is not None else -1
            if tid >= 0:
                uniq.add(tid)
            boxes.append((tid, x1, y1, x2, y2, bh))

    # jersey OCR (skip once a track's number is locked in)
    if reader is not None:
        for tid, x1, y1, x2, y2, bh in boxes:
            if tid < 0 or tid in jersey_final:
                continue
            if bh < args.ocr_min_h * H or (frame_i + tid) % args.ocr_every:
                continue
            ocr_jersey(raw, tid, x1, y1, x2, y2)

    # ---- ball: predict -> detect -> gate ----
    pred = None
    if last_ball is not None:
        damp = 0.96 ** lost
        pred = (last_ball[0] + vel[0] * damp, last_ball[1] + vel[1] * damp)

    br = ball_model.predict(raw, classes=[32], conf=args.ball_conf,
                            imgsz=args.ball_imgsz, verbose=False)[0]
    cands = list(ball_candidates(br))
    if not cands and pred is not None:
        cands = crop_detect(raw, *pred)
        if not cands and lost >= 2:
            # probe further ahead along the velocity (fast passes outrun pred)
            ahead = (last_ball[0] + vel[0] * (lost + 3), last_ball[1] + vel[1] * (lost + 3))
            cands = crop_detect(raw, *ahead)

    best = None
    gate = args.gate * (1 + 0.5 * lost)
    for c, cx, cy in cands:
        colored = ball_colored(raw, cx, cy)
        if pred is not None:
            d = ((cx - pred[0]) ** 2 + (cy - pred[1]) ** 2) ** 0.5
            if d > gate and c < 0.45:
                continue
            score = c + 0.3 * max(0.0, 1 - d / gate) + (0.15 if colored else 0)
        else:
            floor_conf = 0.18 if colored else args.acq_conf
            if c < floor_conf or cy < 0.12 * H:
                continue
            score = c + (0.15 if colored else 0)
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
        last_real = ball_pt; last_ball = ball_pt; lost = 0
    elif pred is not None and lost < args.ball_hold:
        ball_pt = pred; last_ball = pred; lost += 1
    else:
        last_ball = None; last_real = None; vel = (0.0, 0.0); lost = 0
        trail.clear()

    # ---- draw ----
    if rim_hit is not None:
        x, y, sc = rim_hit
        th_, tw_ = rim_tmpl.shape
        cv2.rectangle(frame, (int(x), int(y)), (int(x + tw_), int(y + th_)), YELLOW, 2)
        cv2.putText(frame, "BASKET", (int(x), int(y) - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, YELLOW, 2, cv2.LINE_AA)

    for tid, x1, y1, x2, y2, bh in boxes:
        cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), GREEN, 2)
        cv2.putText(frame, jersey_label(tid), (int(x1), int(y1) - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, GREEN, 2, cv2.LINE_AA)

    if ball_pt is not None:
        if ball_real or lost <= 8:      # long extrapolations show the marker but stop painting trail
            trail.append((int(ball_pt[0]), int(ball_pt[1])))
        for k in range(1, len(trail)):
            (ax, ay), (bx, by) = trail[k - 1], trail[k]
            if abs(ax - bx) > 110 or abs(ay - by) > 110:
                continue
            cv2.line(frame, (ax, ay), (bx, by), ORANGE, 2, cv2.LINE_AA)
        r = 12 if ball_real else 9
        cv2.circle(frame, (int(ball_pt[0]), int(ball_pt[1])), r, ORANGE, 3, cv2.LINE_AA)
        cv2.putText(frame, "BALL" if ball_real else "BALL?",
                    (int(ball_pt[0]) + 14, int(ball_pt[1]) - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, ORANGE, 2, cv2.LINE_AA)

    ids = sum(1 for t, *_ in boxes if t in jersey_final)
    cv2.rectangle(frame, (0, 0), (560, 34), (0, 0, 0), -1)
    bs = "yes" if ball_real else ("held" if ball_pt is not None else "--")
    rs = "yes" if rim_hit else "--"
    cv2.putText(frame, f"players: {len(boxes)} (#id {ids})  ball: {bs}  basket: {rs}",
                (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, YELLOW, 2, cv2.LINE_AA)

    writer.write(frame)
    frame_i += 1
    if frame_i % 60 == 0:
        nums = {t: n for t, n in jersey_final.items()}
        print(f"  frame {frame_i}/{N}  players={len(boxes)} ball={bs} basket={rs} jerseys={nums}", flush=True)

writer.release(); cap.release()
print(f"done. {frame_i} frames, {len(uniq)} track ids, jerseys resolved: {jersey_final}", flush=True)
