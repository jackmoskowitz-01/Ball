# AUTOCODE MVP — Detailed Spec

## 1. Executive Summary

**Vision:** A laptop/box that sits next to the video coordinator in a D1 gym, takes the same live feed as the human coder, and autonomously produces a SportsCode-quality timeline using that team's exact custom taxonomy — with no human analyst clicking.

Hudl built for everyone. We build for one team at a time. Their language, their buttons, their operations.

## 2. The Problem — Why That Screenshot Exists

Right now at every D1 game:

- **Left monitor:** Live game feed
- **Right monitor:** Custom code window with 40–80 buttons: player names [Jonah, Sario, Jennings, Carter... Ward], shot contexts [Transition 3FG, Swing 3FG, No Assist 3FG, Kick Out 3FG, Contested FG, Uncontested FG], results [+2FG, -2FG, +3FG, -3FG], stats [ORB, DRB, ASST, BLK, STL, TO, FF, FA], plus a clickable shot chart [0/1, 1/1, 2/3]
- **Bottom:** Timeline building live with hundreds of instances per game

A GA has to watch, decide, and click 3–5 buttons per possession for 2 hours straight, live. Issues:

- **Labor:** 2–3 people per game, 20 hrs/week per team. Mid-majors can't staff it.
- **Error:** Fatigue = missed tags, wrong shooter ID, 0.5–1s late starts. Coaches don't trust the data at halftime.
- **No portability:** When that GA graduates, the taxonomy knowledge leaves.
- **Not live enough:** True halftime adjustments need the timeline at the buzzer, not 30 mins after.

## 3. Why No One Has Solved Custom Live Coding

**Hudl Assist:** Post-game upload. Generic tags. Takes 2–4 hours. Not live, not custom.

**Hudl IQ:** AI for football formations/routes/coverage at 30fps. Impressive, but football-only, and locked to Hudl's ontology. You can't import your "Ghost Veer" concept.

**Second Spectrum / Genius Sports:** Official NBA tracking. 6-camera install, $150k+/yr, outputs x,y tracking + generic PNR/ISO. They auto-index action within seconds, but they will never let VCU define what a "No Assist 3FG" means.

**The gap:** Everyone does generic, post-game, or expensive hardware. No one does custom taxonomy + live + single feed + SportsCode XML out. Because custom doesn't scale if you try to train a new model per team.

## 4. The Insight

The need for live coders exists because no platform can cater to each team's specific language and operations. Hudl caters to everyone, not specific teams.

**Your moat is not the detector. It's the Taxonomy Compiler.**

## 5. Product Definition — MVP v0.1

**What it does:**

- **Input:** 1x HDMI/SDI 1080p30 clean feed (what they send to SportsCode), roster CSV with names/numbers, opponent roster
- **Output:**
  - `GameID_SportsCode.xml` — drops directly into SportsCode timeline with same row names as screenshot [HDL, CLF, Jonah, Sario...]
  - MP4 with chapters
  - Live confidence view (optional): shows what AI thinks it clicked
- **Must support in MVP:** Possession start/end, Transition vs Half-Court, Make/Miss, Shooter ID (top 8 rotation), Shot Type mapping (8 shot types), ORB/DRB, ASST, BLK, STL, TO, Foul, plus shot chart x,y

**What it doesn't need in v0.1:** Jersey color change detection, full bench ID, advanced PNR coverage, football.

**Commercial Deployment:**

- **Hardware:** M3 Max MacBook Pro or small edge box (NVIDIA Jetson Orin / Mac Mini) with Blackmagic capture card
- **Setup:** <15 min. Plug into capture, select "Tonight's Code Window.xml", select roster, hit Start Game. Offline capable — no gym WiFi needed.
- **Fail-safe:** If confidence <70%, flag instance yellow for 2-min post-game review. But still outputs timeline with no human during game.

## 6. The Taxonomy Compiler — Core IP

This is a no-code UI that replaces 3 weeks of engineering per team:

**Step 1: Import**
User uploads their SportsCode code window .xml.

**Step 2: Map to Canonical**
Internal canonical events:
`canonical_shot = {type: 3FG, context: [Transition, Swing, NoAssist, KickOut], contested: bool, shooter_id}`

They drag:
- My "Transition 3FG" = `canonical_shot.type=3FG AND game_state=Transition AND clock<8s`
- My "Ward" button = `roster_id 12`

**Step 3: Define Logic**
For each code, define start/end:
- ORB instance = from miss to possession change + 2s
- Kick Out 3FG = paint touch in last 2s + pass out + 3FG attempt

Compile to JSON rules. After 10 teams, you have a library: "Want Kick Out 3FG? 8 teams define it like this — clone?"

**This is how you scale custom.**

## 7. Technical Architecture

**Layer A — Perception (runs at 30fps on edge):**

- Detection: YOLOv8x fine-tuned on NCAAB
- Tracking: BoT-SORT with ReID to maintain ID through screens
- Jersey OCR: Parseq + team color clustering, roster-constrained (only look for numbers on active roster)
- Court Homography: Keypoint model to detect 20 court points each frame → top-down coordinates for shot chart
- Ball + Hoop detection: Separate small models

**Layer B — Game State Machine (15hz):**
Deterministic FSM:
`Dead Ball → Inbound → Possession (0-30s) → Shot → Rebound/Foul → Dead`
Tracks shot clock via OCR, score via scorebug OCR, possession arrow via logic. This gives you Transition detection (possession <8s).

**Layer C — Action Recognition (2–3fps, temporal window 3 sec):**
Transformer on top of tracking + pose:

- Shot vs Pass vs Dribble
- Contested vs Uncontested (defender distance from pose)
- Pass type: Swing vs Kick Out (requires tracking ball movement from paint to arc)

Use pretrained VideoMAE + fine-tune on 50 labeled D1 games.

**Layer D — Timeline Builder:**
Takes canonical events + Taxonomy Rules → Emits instances with start, end, labels, notes. Exports SportsCode XML with exact row structure from the team's code window.

## 8. Data Strategy

Need 50 games of paired data: Video + Timeline.

- **Month 1:** Hire 2 ex-D1 video coordinators on Upwork. Pay them to label 30 open-source D1 games in the canonical schema.
- **Month 2:** Partner with 2 local D1s (Georgetown, GW, American, Howard — DC-based). Offer: "We code your next 10 games free, you give us last season's film + SportsCode timelines." That paired data is gold.
- **Month 3+:** Self-training loop. Run v0.1 live, GA corrects in Sorter for 5 mins post-game, ingest diff nightly.

## 9. Success Metrics for MVP Pilot

- Top 10 codes accuracy: >90% vs human
- Shooter ID (top 8 players): >85% live
- Timeline drift: Start times within 0.5s of human 80% of time
- Latency: Instance appears in timeline <3s after action
- Zero crashes for full 40-min game
- Coordinator NPS: Would you trust this for halftime?

## 10. What We Are NOT Building in v0.1

- Football (needs All-22 + 22 IDs)
- Practice film
- Cloud processing (edge only)
- Automated scouting report (just the timeline first)
- Full 15-man ID — start with 8-man rotation

## 11. 12-Week Build Plan

- **Weeks 1–2:** Get 10 games labeled, build court homography + detection baseline. Output: Video → player boxes + top-down dots.
- **Weeks 3–4:** Game State Machine + Make/Miss + ORB/DRB. Output: Can generate timeline with only those 4 codes.
- **Weeks 5–6:** Jersey OCR + Shooter ID + Taxonomy Compiler v1 (import XML, map).
- **Weeks 7–8:** Shot context (Transition/Swing/KickOut/Contested) model + shot chart x,y.
- **Weeks 9–10:** Edge deployment box, SportsCode XML exporter that exactly matches the team's code window structure.
- **Weeks 11–12:** Live pilot in gym with Georgetown/GW JV game. Debug latency, occlusion, scoreboard glare.

## 12. Go-to-Market

- First 3 teams free for season in exchange for testimonial + data rights.
- Then $1,500/mo per basketball team (in-season only). Football later at $3,500/mo.
- Sell to Director of Ops / Video Coordinator, not Head Coach. Their pain is hiring GAs.
