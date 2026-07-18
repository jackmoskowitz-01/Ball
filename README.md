# AUTOCODE

Live AI game coding for college basketball. Plug in a video feed, get a SportsCode timeline — no human clicking.

---

## What it does

- Takes a 1080p30 HDMI/SDI feed (same one the human coder watches)
- Outputs `GameID_SportsCode.xml` that drops directly into SportsCode
- Works offline, on edge hardware, with <3s latency

## What it codes (MVP)

| Category | Tags |
|---|---|
| Possession | Start/end, Transition vs Half-Court |
| Shot | Make/Miss, 8 shot types, shot chart x/y |
| Shooter | Top 8 rotation players by jersey OCR |
| Stats | ORB, DRB, ASST, BLK, STL, TO, Foul |

## The key idea

Every team has their own button names — "Kick Out 3FG", "Ward", "Swing". The **Taxonomy Compiler** imports their existing SportsCode XML and maps those buttons to canonical events. Custom doesn't mean rebuilding from scratch for each team.

## Hardware

M3 Max MacBook Pro or Mac Mini + Blackmagic capture card. Setup under 15 min.

## Repo

```
docs/           Spec and build plan
perception/     Detection, tracking, jersey OCR, court homography
gamestate/      Possession FSM, shot clock OCR, score tracking
actions/        Shot/pass classifier, contested detection
timeline/       SportsCode XML exporter
compiler/       Taxonomy Compiler UI
```

## Docs

- [Full spec](docs/SPEC.md)

## Numbers

- Target accuracy: >90% on top 10 codes
- Shooter ID: >85%
- Timeline start drift: <0.5s vs human (80% of instances)
- Confidence threshold: flag yellow below 70% for post-game review
- Price: $1,500/mo per basketball team (in-season)
