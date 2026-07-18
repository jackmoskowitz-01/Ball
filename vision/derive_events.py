#!/usr/bin/env python3
"""
Derive coded game events from tracking data (Layer B: game-state).

Input : tracking.json from `track_game.py --export-json` + the source video
        (for scoreboard OCR ground truth on makes).
Output: events.json — possessions, passes, shot attempts, makes (scorebug-
        verified), and rebounds, each with video timestamps, the player
        (jersey number when resolved), team, and a confidence score.

  python derive_events.py tracking.json GAME.mp4 events.json \
      --team-a WSH --team-b UTAH --clock "9:41" --quarter 2

Heuristics (documented so you can argue with them):
- possession  : ball inside/near a player's box for >=4 consecutive frames
- pass        : possession A -> short flight -> possession B on the same team
- shot attempt: ball in flight enters the rim neighborhood (last known rim
                box is carried while the rim is briefly occluded)
- make        : the broadcast scorebug score changes (OCR, digits only) —
                this is ground truth, attributed to the pending shot
- rebound     : possession established after a missed attempt (ORB if the
                shooter's team keeps it, DRB otherwise)
"""
import argparse
import json

import cv2

ap = argparse.ArgumentParser()
ap.add_argument("tracking"); ap.add_argument("video"); ap.add_argument("out")
ap.add_argument("--team-a", default="A", help="name for the dark-jersey team")
ap.add_argument("--team-b", default="B", help="name for the light-jersey team")
ap.add_argument("--clock", default=None, help="game clock at frame 0, e.g. '9:41'")
ap.add_argument("--quarter", type=int, default=1)
ap.add_argument("--score-every", type=int, default=12, help="scorebug OCR cadence (frames)")
ap.add_argument("--alias", default=None,
                help="analyst override for unresolved reads: tid:jersey pairs, e.g. '3:15,7:23'")
args = ap.parse_args()

data = json.load(open(args.tracking))
meta, frames = data["meta"], data["frames"]
FPS, W, H = meta["fps"], meta["width"], meta["height"]
jerseys = {int(k): v for k, v in meta["jerseys"].items()}
teams = {int(k): v for k, v in meta["teams"].items()}
if args.alias:                      # analyst corrections for unresolved tracks
    for pair in args.alias.split(","):
        tid, num = pair.split(":")
        jerseys[int(tid)] = num.strip()
team_name = {"A": args.team_a, "B": args.team_b}


def pname(tid):
    if tid in jerseys:
        return "#" + jerseys[tid]
    return "P" + str(tid)


def pteam(tid):
    return team_name.get(teams.get(tid, ""), None)


# ---------------------------------------------------------------- possession
def box_dist(ball, box):
    x, y = ball[0], ball[1]
    x1, y1, x2, y2 = box
    dx = max(x1 - x, 0, x - x2)
    dy = max(y1 - y, 0, y - y2)
    return (dx * dx + dy * dy) ** 0.5


GRAB = 46          # px: ball this close to a box counts as "with" that player
CONFIRM = 4        # consecutive frames to grant possession

raw_holder = []    # per frame: tid or None
for fr in frames:
    holder = None
    if fr["ball"] is not None:
        best = None
        for p in fr["players"]:
            d = box_dist(fr["ball"], p["box"])
            if d <= GRAB and (best is None or d < best[0]):
                best = (d, p["tid"])
        holder = best[1] if best else None
    raw_holder.append(holder)

possessions = []   # {tid, f0, f1}
cur = None; streak = 0; cand = None
for i, h in enumerate(raw_holder):
    if h is not None and h == cand:
        streak += 1
    else:
        cand = h; streak = 1
    if cand is not None and streak >= CONFIRM:
        if cur is None or cur["tid"] != cand:
            if cur is not None:
                cur["f1"] = i - CONFIRM
                possessions.append(cur)
            cur = {"tid": cand, "f0": i - CONFIRM + 1, "f1": None}
if cur is not None:
    cur["f1"] = len(frames) - 1
    possessions.append(cur)
possessions = [p for p in possessions if p["f1"] - p["f0"] >= 3]

# annotate each possession with the jersey number ACTUALLY assigned during
# that window (per-frame assignment survives ByteTrack id swaps)
from collections import Counter  # noqa: E402
for p in possessions:
    js = [pl["j"] for fr in frames[p["f0"]:p["f1"] + 1]
          for pl in fr["players"] if pl["tid"] == p["tid"] and pl.get("j")]
    p["jersey"] = Counter(js).most_common(1)[0][0] if js else jerseys.get(p["tid"])
    p["team"] = pteam(p["tid"])


def pname_p(p):
    return "#" + p["jersey"] if p.get("jersey") else "P" + str(p["tid"])

# ---------------------------------------------------------------- rim carry
last_rim = None
rim_at = []
for fr in frames:
    if fr["rim"] is not None:
        last_rim = fr["rim"]
    rim_at.append(last_rim)

# ---------------------------------------------------------------- shots
shots = []         # {"poss": possession, "f": rim-approach frame, "release_f": release}
for k in range(len(possessions)):
    p = possessions[k]
    nxt_f = possessions[k + 1]["f0"] if k + 1 < len(possessions) else len(frames)
    # flight window after this possession ends
    approached = None
    for i in range(p["f1"], min(nxt_f, p["f1"] + int(3.5 * FPS))):
        fr = frames[i]; rim = rim_at[i]
        if fr["ball"] is None or rim is None:
            continue
        bx, by = fr["ball"][0], fr["ball"][1]
        rx, ry = rim[0] + rim[2] / 2, rim[1] + rim[3] * 0.75   # rim sits low in the template
        d = ((bx - rx) ** 2 + (by - ry) ** 2) ** 0.5
        # rim neighborhood, or ball above rim level while horizontally close
        if d < rim[2] * 1.8 or (by < rim[1] + rim[3] and abs(bx - rx) < rim[2] * 2.2):
            approached = i
            break
    if approached is not None:
        shots.append({"poss": p, "f": approached, "release_f": p["f1"]})

# ---------------------------------------------------------------- scorebug OCR
import easyocr  # noqa: E402  (heavy import after fast parsing failures)
reader = easyocr.Reader(["en"], gpu=False, verbose=False)
cap = cv2.VideoCapture(args.video)


def read_scores(frame):
    """OCR the two score numbers off the bottom scorebug strip."""
    strip = frame[int(H * 0.885):int(H * 0.97), int(W * 0.30):int(W * 0.62)]
    strip = cv2.resize(strip, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    reads = reader.readtext(strip, allowlist="0123456789", min_size=10)
    # tokens in x order; scores are the two HIGH-confidence numbers (the
    # strip also yields low-conf junk from logos/records — 0.9 filters it)
    toks = sorted([(r[0][0][0], r[1], r[2]) for r in reads])
    nums = [t for t in toks if t[2] >= 0.9 and 1 <= len(t[1]) <= 3]
    if len(nums) == 2:
        return int(nums[0][1]), int(nums[1][1])
    return None


score_track = []   # (frame_idx, scoreA, scoreB)
fi = 0
while True:
    ok, fr = cap.read()
    if not ok:
        break
    if fi % args.score_every == 0:
        s = read_scores(fr)
        if s is not None:
            score_track.append((fi, s[0], s[1]))
    fi += 1
cap.release()

makes = []         # {f, team, points}
for j in range(1, len(score_track)):
    f0, a0, b0 = score_track[j - 1]
    f1, a1, b1 = score_track[j]
    # debounce: the new score must persist into the following sample
    if j + 1 < len(score_track):
        _, a2, b2 = score_track[j + 1]
        if (a2, b2) != (a1, b1):
            continue
    # scores only ever go up by 1-3; anything else is an OCR misread
    if a1 - a0 in (1, 2, 3) and b1 == b0:
        makes.append({"f": f1, "team": args.team_a, "points": a1 - a0})
    elif b1 - b0 in (1, 2, 3) and a1 == a0:
        makes.append({"f": f1, "team": args.team_b, "points": b1 - b0})

# ---------------------------------------------------------------- assemble events
clock0 = None
if args.clock:
    m, s = args.clock.split(":")
    clock0 = int(m) * 60 + int(s)


def gclock(f):
    if clock0 is None:
        return None
    s = max(0, clock0 - f / FPS)
    return f"{int(s // 60)}:{int(s % 60):02d}"


events = []


def add(type_, f, dur, poss=None, team=None, label=None, conf=80, **kw):
    t = f / FPS
    ev = {"type": type_, "t": round(t, 2), "tEnd": round(t + dur, 2),
          "conf": conf, "quarter": args.quarter, "clock": gclock(f)}
    if poss is not None:
        ev["player"] = pname_p(poss); ev["jersey"] = poss.get("jersey")
        team = team or poss.get("team")
    if team: ev["team"] = team
    ev["label"] = label or type_
    ev.update(kw)
    events.append(ev)


for p in possessions:
    dur = (p["f1"] - p["f0"]) / FPS
    add("possession", p["f0"], dur, poss=p, conf=85,
        label=f"Possession · {pname_p(p)}")

for k in range(1, len(possessions)):
    a, b = possessions[k - 1], possessions[k]
    gap = (b["f0"] - a["f1"]) / FPS
    if 0 < gap <= 1.4 and a["team"] and a["team"] == b["team"] and a["tid"] != b["tid"]:
        add("pass", a["f1"], gap, poss=a, conf=75,
            label=f"Pass · {pname_p(a)} → {pname_p(b)}", to=pname_p(b))

for sh in shots:
    add("shot", sh["release_f"], (sh["f"] - sh["release_f"]) / FPS + 0.8,
        poss=sh["poss"], conf=70, label=f"Shot · {pname_p(sh['poss'])}")

for mk in makes:
    # attribute to the latest shot attempt within the previous ~4s
    shooter = None
    for sh in shots:
        if 0 <= mk["f"] - sh["f"] <= 4 * FPS:
            shooter = sh["poss"]
    lbl = f"+{mk['points']}FG · {pname_p(shooter) if shooter is not None else mk['team']}"
    add("make", max(0, mk["f"] - int(1.5 * FPS)), 2.0,
        poss=shooter, team=mk["team"], conf=95, points=mk["points"], label=lbl)

# rebounds: next possession after an unconverted shot approach
make_frames = [m["f"] for m in makes]
for sh in shots:
    converted = any(0 <= mf - sh["f"] <= 4 * FPS for mf in make_frames)
    if converted:
        continue
    nxt = next((p for p in possessions if p["f0"] > sh["f"]), None)
    if nxt and (nxt["f0"] - sh["f"]) / FPS < 3:
        orb = nxt["team"] == sh["poss"]["team"]
        add("rebound", nxt["f0"], 1.5, poss=nxt, conf=70,
            label=("ORB" if orb else "DRB") + f" · {pname_p(nxt)}", orb=orb)

events.sort(key=lambda e: e["t"])
json.dump({"meta": {"fps": FPS, "teamA": args.team_a, "teamB": args.team_b,
                    "quarter": args.quarter, "clock0": args.clock,
                    "jerseys": jerseys, "teams": {str(k): team_name.get(v) for k, v in teams.items()}},
           "events": events}, open(args.out, "w"), indent=1)
print(f"{len(possessions)} possessions, {len(shots)} shot attempts, "
      f"{len(makes)} makes (scorebug), {len(events)} events -> {args.out}")
for e in events:
    print(f"  {e['t']:6.2f}s  {e['label']}  ({e.get('team','?')}, conf {e['conf']})")
