# AUTOCODE

Autonomous live game coding for college basketball. An edge box takes the same clean feed a human coder watches and produces a SportsCode-quality timeline in the team's **exact custom taxonomy** — no analyst clicking, live, at the buzzer.

Hudl built for everyone. We build for one team at a time.

## The core bet

The moat is not the detector — it's the **Taxonomy Compiler**: a no-code tool that imports a team's SportsCode code window XML and maps their buttons ("Kick Out 3FG", "Ward") onto canonical events + rules. That's what makes *custom* scale.

## Repo layout (planned)

```
docs/           Spec, build plan, decisions
perception/     Layer A — detection, tracking, jersey OCR, court homography (30fps)
gamestate/      Layer B — deterministic possession FSM, shot/score clock OCR (15hz)
actions/        Layer C — action recognition transformer (shot/pass, contested, pass type)
timeline/       Layer D — canonical events + taxonomy rules → SportsCode XML export
compiler/       Taxonomy Compiler — code window import, canonical mapping, JSON rules
```

## Docs

- [Full MVP spec](docs/SPEC.md) — problem, architecture, data strategy, 12-week plan, GTM

## MVP v0.1 scope

Single 1080p30 feed in → SportsCode XML + chaptered MP4 out. Possession, transition vs half-court, make/miss, shooter ID (8-man rotation), 8 shot types, ORB/DRB/ASST/BLK/STL/TO/foul, shot chart x,y. Edge-only, offline-capable, <3s latency.
