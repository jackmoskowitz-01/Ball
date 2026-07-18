# vision / AUTOCODE perception pipeline

Track **players (with real jersey numbers), the ball, and the basket** in
broadcast basketball film. One command per game.

Validated on NBA 2K26 Summer League broadcast footage (WSH vs UTAH).

## Setup (one time, ~5 min)

    cd vision
    python3 -m venv venv && source venv/bin/activate
    pip install -r requirements.txt

Model weights (YOLO11, ~110MB; OCR models ~65MB) download automatically on
first run. Everything runs locally after that — no cloud, gym WiFi optional.

## Run a game

    python track_game.py GAME.mp4 GAME_tracked.mp4 \
        --roster "5,13,19,33,58,15,36,44,60,77"

Pass both teams' jersey numbers in `--roster` — OCR reads that don't match
a rostered number are discarded, which is what keeps low-resolution
misreads (58→59, 36→38) off your film. Run without it and the pipeline
still works, just with less protection against wrong numbers.

What you get, drawn on every frame:
- **Players**: green boxes labeled with their real jersey number (`#44`)
  once OCR is confident, `P<id>` before that. Bench and crowd are filtered
  out automatically (hardwood-under-feet court test).
- **Ball**: orange marker + motion trail. Solid `BALL` = detected this
  frame; `BALL?` = briefly occluded, position extrapolated along its
  velocity (so passes and shot arcs stay tracked).
- **Basket**: yellow `BASKET` box, template-tracked through camera pans;
  hides honestly when the rim is off-frame or occluded.

For web/QuickTime playback, re-encode the output:

    ffmpeg -i GAME_tracked.mp4 -c:v libx264 -pix_fmt yuv420p -movflags +faststart final.mp4

## Basket calibration (once per venue/camera)

Auto-acquire tries to find the rim itself, but only trusts a confident,
unambiguous match — otherwise the basket overlay is disabled and it tells
you. The reliable path (30 seconds, once per venue):

    python track_game.py GAME.mp4 out.mp4 --dump-frame frame0.png
    # open frame0.png in Preview, note the backboard box: x, y, width, height
    python track_game.py GAME.mp4 out.mp4 --rim 179,101,90,95

Template tracking handles camera pans from there.

## Tuning knobs (defaults are sane)

| flag | default | what it does |
|---|---|---|
| `--conf` | 0.30 | player detection threshold |
| `--min-h` / `--tall-h` | 0.05 / 0.28 | size filters (frame-height fractions) |
| `--wood-frac` | 0.40 | court-filter strictness (lower = keep more people) |
| `--roster` | — | valid jersey numbers, comma-separated (**use it** — kills misreads) |
| `--ocr-every` | 3 | OCR cadence per track (higher = faster, slower to name) |
| `--no-ocr` | — | skip jersey OCR entirely (fastest) |
| `--ball-imgsz` | 1536 | ball detection resolution (higher = finds smaller balls) |
| `--ball-hold` | 24 | frames to extrapolate an occluded ball |
| `--no-basket` | — | skip basket tracking |

## Derive coded events (Layer B — game-state)

Turn the tracking into an actual coded timeline:

    python track_game.py GAME.mp4 out.mp4 --rim ... --roster ... --export-json tracking.json
    python derive_events.py tracking.json GAME.mp4 events.json \
        --team-a WSH --team-b UTAH --clock "9:41" --quarter 2

`events.json` contains possessions, passes, shot attempts, **makes verified
by scoreboard OCR** (the broadcast scorebug is ground truth), and rebounds —
each with video timestamps, player jersey + team (auto-classified by jersey
color), and a confidence score. The demo page (`demo/index.html`) loads this
file and builds its timeline from it: every clip seeks to the real footage
moment.

Heuristics are documented at the top of `derive_events.py` — argue with
them there.

## How it works

- **Players** — YOLO11x + ByteTrack (`tracker_stable.yaml`, large buffer so
  ids survive occlusions) + court filter: a detection only counts if the
  floor under its feet is hardwood-colored.
- **Jerseys** — torso bands are OCR'd every few frames (digits only, 4×
  upscale); reads accumulate confidence-weighted votes per track id.
  Numbers are assigned dynamically each frame with a one-owner rule: a
  number belongs to the live track with the strongest evidence, so when
  ByteTrack swaps ids across an occlusion the label snaps back to the
  right body instead of riding the wrong one. Resolved tracks keep being
  sampled (slower cadence) so drift gets caught.
- **Ball** — full-frame low-conf detection at high resolution, fused with a
  constant-velocity model: candidates are gated by distance to the
  predicted position (shot arcs pass the gate, crowd false-positives
  don't); on a miss the position extrapolates along the velocity and two
  zoomed re-detects run — at the prediction and *ahead* of it (fast passes
  outrun a damped prediction); a basketball-color prior breaks ties.
- **Basket** — normalized cross-correlation template tracking with local
  search + global rescan, threshold 0.5, from a one-time calibration (or a
  confident auto-acquire).

## Known limits (read before selling it to your coaches)

- Jersey numbers resolve only when a track's torso is visible and big
  enough; expect the first few seconds of a possession before names lock.
- The ball still drops for stretches where it's fully hidden behind
  bodies. The marker goes away rather than guessing — the durable fix is a
  small fine-tuned ball/rim detector, which is the top item on the
  perception roadmap.
- Auto rim acquisition is best-effort by design; calibrate with `--rim`
  for production use.

## Roadmap

1. Fine-tuned basketball detector (ball + rim classes) — removes the two
   limits above
2. Team split by jersey color; roster CSV → number-to-name mapping
3. Court homography → shot-chart x,y and possession geometry
4. Shot/make/miss events from ball-rim interaction → SportsCode XML
