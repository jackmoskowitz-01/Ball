# vision / player + ball tracking

YOLO11 perception experiments for AUTOCODE, run on real broadcast footage
(NBA 2K26 Summer League, WSH vs UTAH).

## Scripts

### `detect_ball_players.py` (current)
Tracks players **and** the basketball:
- **Players:** YOLO11 + ByteTrack (`tracker_stable.yaml`, big buffer) → each
  player keeps a stable `P##` id through occlusions.
- **Court filter:** a detection only counts if the floor under its feet is
  hardwood-colored (bench/crowd sit on the red apron → dropped). Follows the
  camera automatically; boxes taller than 28% of frame height always pass.
- **Ball:** high-res (1280) low-conf `sports ball` detection, best-per-frame
  with a continuity bonus toward the last known position, hold across short
  gaps (`BALL?` = held), teleport-proof motion trail.

```
python detect_ball_players.py IN.mov OUT.mp4 \
    [--conf 0.30] [--min-h 0.05] [--tall-h 0.28] [--wood-frac 0.40] \
    [--ball-conf 0.10] [--ball-hold 10] [--ball-top 0.22] [--model yolo11x.pt]
```

Note: OpenCV writes `mp4v`, which browsers won't play. For the demo page:
`ffmpeg -i OUT.mp4 -c:v libx264 -pix_fmt yuv420p -movflags +faststart demo/tracked.mp4`

### `detect_players.py` (v1)
Person-only detection + ByteTrack, size filter only. Kept for reference.

## Setup (one time)
    python3 -m venv venv && source venv/bin/activate
    pip install ultralytics            # pulls torch (MPS/Apple-Silicon accelerated)

## Next steps
- Jersey-number OCR → map `P##` ids to real roster numbers (60, 44, 19…)
- Team split by jersey color (red = WSH, white = UTAH)
- Court homography → shot chart x,y in court coordinates
