'use client';
/**
 * Frame-accurate basketball label editor.
 *
 * Object tools (Shift+key, or click toolbar — plain letters belong to events):
 *   ⇧B ball · ⇧P player (cycles offense/defense) · ⇧R rim · ⇧K backboard
 *   ⇧N net · ⇧C court polygon · V select
 * Object ops: T set trackingId · I interpolate (press on two frames, same id)
 *   · ⌫ delete · arrows step frames · space play/pause · Z zoom 200% crosshair
 * Event hotkeys (exactly per spec): S gather · R RELEASE keyframe · M make ·
 *   X miss · E rebound start · W rebound end · A assist pass · B block · L steal
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Rect, Line, Text, Circle } from 'react-konva';
import type { ObjectAnnotation } from '@autocode/types';

type Ev = {
  localId: string;
  type: string;
  keyFrame: number;
  startFrame: number | null;
  endFrame: number | null;
  payload: Record<string, any>;
  features: Record<string, any> | null;
  source: string;
  confidence?: number | null;
};

const LANES = ['shot', 'rebound', 'assist', 'block', 'steal', 'possession_change'];
const LANE_LABEL: Record<string, string> = {
  shot: 'Shot', rebound: 'Rebound', assist: 'Assist', block: 'Block',
  steal: 'Steal', possession_change: 'Possession',
};
const TOOL_CLASSES: Record<string, string> = {
  ball: 'ball', player: 'player_offense', rim: 'rim', backboard: 'backboard', net: 'net',
};
let uid = 0;
const nid = () => `n${Date.now().toString(36)}${uid++}`;

export default function LabelEditor({ videoId }: { videoId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [meta, setMeta] = useState<any>(null);
  const [frames, setFrames] = useState<Map<number, ObjectAnnotation[]>>(new Map());
  const [sources, setSources] = useState<Map<number, string>>(new Map());
  const [edited, setEdited] = useState<Set<number>>(new Set());
  const [court, setCourt] = useState<ObjectAnnotation[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [cur, setCur] = useState(0);
  const [tool, setTool] = useState('select');
  const [teamCycle, setTeamCycle] = useState<'player_offense' | 'player_defense'>('player_offense');
  const [selId, setSelId] = useState<string | null>(null);
  const [selEvent, setSelEvent] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [courtDraft, setCourtDraft] = useState<{ x: number; y: number }[]>([]);
  const [pendingShot, setPendingShot] = useState<{ gather: number } | null>(null);
  const [pendingRebound, setPendingRebound] = useState<{ start: number } | null>(null);
  const [interpAnchor, setInterpAnchor] = useState<{ frame: number; tid: number; cls: string } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [toast, setToast] = useState<{ msg: string; danger?: boolean } | null>(null);
  const [approved, setApproved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dispSize, setDispSize] = useState({ w: 960, h: 540 });
  const [tlZoom, setTlZoom] = useState(2); // px per frame in event timeline

  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const fps = meta?.video?.fps ?? 30;
  const W = meta?.video?.width ?? 1920;
  const H = meta?.video?.height ?? 1080;
  const totalFrames = meta?.video?.frames ?? 1;

  const say = useCallback((msg: string, danger = false) => {
    setToast({ msg, danger });
    setTimeout(() => setToast(null), 2600);
  }, []);

  // ---------- load ----------
  useEffect(() => {
    fetch(`/api/videos/${videoId}`).then((r) => r.json()).then((d) => {
      setMeta(d);
      const fm = new Map<number, ObjectAnnotation[]>();
      const sm = new Map<number, string>();
      const courtObjs: ObjectAnnotation[] = [];
      for (const f of d.frames) {
        const nonCourt = (f.objects as ObjectAnnotation[]).filter((o) => {
          if (o.cls === 'court') { if (!courtObjs.length || f.source === 'human') courtObjs.push(o); return false; }
          return true;
        });
        fm.set(f.frameNumber, nonCourt);
        sm.set(f.frameNumber, f.source);
      }
      setFrames(fm); setSources(sm); setCourt(courtObjs);
      // dedup: hide teacher event when a human event of same type is within 5 frames
      const human = d.events.filter((e: any) => e.source === 'human');
      const evs: Ev[] = d.events
        .filter((e: any) => e.source === 'human' ||
          !human.some((h: any) => h.type === e.type && Math.abs(h.keyFrame - e.keyFrame) <= 5))
        .map((e: any) => ({
          localId: nid(), type: e.type, keyFrame: e.keyFrame,
          startFrame: e.startFrame, endFrame: e.endFrame,
          payload: e.payload, features: e.features, source: e.source, confidence: e.confidence,
        }));
      setEvents(evs);
      setApproved(d.video.status === 'approved');
      const p = new URLSearchParams(window.location.search).get('f');
      if (p) setTimeout(() => seek(Number(p)), 400);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // ---------- video/frame sync ----------
  const seek = useCallback((f: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = (f + 0.5) / fps; // mid-frame: floor() lands on f exactly
  }, [fps]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      setCur(Math.floor(v.currentTime * fps + 1e-6));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fps, meta]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const scale = Math.min(el.clientWidth / W, el.clientHeight / H);
      setDispSize({ w: W * scale, h: H * scale });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, H]);

  const scale = dispSize.w / W;

  // ---------- object helpers ----------
  const curObjects = useMemo(() => frames.get(cur) ?? [], [frames, cur]);
  const allObjects = useMemo(() => [...curObjects, ...court], [curObjects, court]);

  const mutateFrame = useCallback((f: number, fn: (objs: ObjectAnnotation[]) => ObjectAnnotation[]) => {
    setFrames((prev) => {
      const next = new Map(prev);
      next.set(f, fn(prev.get(f) ?? []));
      return next;
    });
    setSources((prev) => new Map(prev).set(f, 'human'));
    setEdited((prev) => new Set(prev).add(f));
  }, []);

  const nextTid = useCallback(() => {
    let max = 1;
    for (const objs of frames.values())
      for (const o of objs) if (o.trackingId && o.trackingId > max) max = o.trackingId;
    return max + 1;
  }, [frames]);

  const ballAt = useCallback((f: number) => (frames.get(f) ?? []).find((o) => o.cls === 'ball'), [frames]);
  const playersAt = useCallback((f: number) => (frames.get(f) ?? []).filter((o) => o.cls.startsWith('player')), [frames]);

  const nearestPlayerToBall = useCallback((f: number, opts: { cls?: string; not?: number | null; maxDist?: number } = {}) => {
    const b = ballAt(f);
    if (!b) return null;
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    let best: ObjectAnnotation | null = null, bestD = opts.maxDist ?? 150;
    for (const p of playersAt(f)) {
      if (opts.cls && p.cls !== opts.cls) continue;
      if (opts.not != null && p.trackingId === opts.not) continue;
      const dx = Math.max(p.x - bx, 0, bx - (p.x + p.w));
      const dy = Math.max(p.y - by, 0, by - (p.y + p.h));
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }, [ballAt, playersAt]);

  const featuresAt = useCallback((f: number) => {
    const b = ballAt(f);
    const near = nearestPlayerToBall(f, { maxDist: 1e9 });
    let dist = null;
    if (b && near) {
      const bx = b.x + b.w / 2, by = b.y + b.h / 2;
      dist = Math.hypot(
        Math.max(near.x - bx, 0, bx - (near.x + near.w)),
        Math.max(near.y - by, 0, by - (near.y + near.h)),
      );
    }
    return { vx: b?.vx ?? null, vy: b?.vy ?? null, wrist_y: null, elbow_y: null, ball_in_hand_dist: dist };
  }, [ballAt, nearestPlayerToBall]);

  // ---------- stage mouse ----------
  const toVideoCoords = (e: any) => {
    const pos = e.target.getStage().getPointerPosition();
    return { x: pos.x / scale / (zoomed ? 2 : 1), y: pos.y / scale / (zoomed ? 2 : 1) };
  };

  const onStageMouseDown = (e: any) => {
    const p = toVideoCoords(e);
    if (tool === 'court') {
      setCourtDraft((d) => [...d, p]);
      return;
    }
    if (tool !== 'select') {
      dragRef.current = p;
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    if (e.target === e.target.getStage()) setSelId(null);
  };
  const onStageMouseMove = (e: any) => {
    if (!dragRef.current) return;
    const p = toVideoCoords(e);
    const s = dragRef.current;
    setDraft({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };
  const onStageMouseUp = () => {
    if (!dragRef.current || !draft) { dragRef.current = null; return; }
    dragRef.current = null;
    if (draft.w > 4 && draft.h > 4) {
      const cls = tool === 'player' ? teamCycle : TOOL_CLASSES[tool];
      const tid = cls === 'ball' ? 1 : cls.startsWith('player') ? nextTid() : null;
      const o: ObjectAnnotation = {
        id: nid(), cls: cls as any, trackingId: tid, ...draft,
        occluded: false, blurry: false, visible: true, vx: null, vy: null,
        jerseyNumber: null, confidence: null,
      };
      mutateFrame(cur, (objs) => [...objs, o]);
      setSelId(o.id);
      if (tool === 'player') setTeamCycle((t) => (t === 'player_offense' ? 'player_defense' : 'player_offense'));
    }
    setDraft(null);
  };

  const closeCourtPolygon = useCallback(() => {
    if (courtDraft.length < 3) { setCourtDraft([]); return; }
    const kinds: any[] = ['boundary', 'three_pt', 'paint', 'ft_line'];
    const kind = kinds[Math.min(court.length, 3)];
    const o: ObjectAnnotation = {
      id: nid(), cls: 'court', trackingId: null, x: 0, y: 0, w: 0, h: 0,
      occluded: false, blurry: false, visible: true, vx: null, vy: null,
      jerseyNumber: null, confidence: null, polygon: courtDraft, polygonKind: kind,
    };
    setCourt((c) => [...c, o]);
    setEdited((prev) => new Set(prev).add(cur)); // court rides along on save
    setCourtDraft([]);
    say(`court ${kind} polygon saved — auto-copied to all frames`);
  }, [courtDraft, court.length, cur, say]);

  // ---------- events ----------
  const addEvent = useCallback((ev: Omit<Ev, 'localId' | 'source'>) => {
    const e: Ev = { ...ev, localId: nid(), source: 'human' };
    setEvents((prev) => [...prev, e].sort((a, b) => a.keyFrame - b.keyFrame));
    setSelEvent(e.localId);
    return e;
  }, []);

  const eventKey = useCallback((key: string) => {
    if (key === 's') {
      setPendingShot({ gather: cur });
      say(`shot gather @${cur} — press R at release`);
    } else if (key === 'r') {
      const gather = pendingShot?.gather ?? cur;
      const shooter = nearestPlayerToBall(gather) ?? nearestPlayerToBall(cur);
      if (!shooter) { say('No shooter found - label player first', true); return; }
      addEvent({
        type: 'shot', keyFrame: cur, startFrame: gather, endFrame: null,
        payload: {
          gatherFrame: gather, releaseFrame: cur, apexFrame: null, endFrame: null,
          result: null, shotType: '2pt', shooterTrackingId: shooter.trackingId,
        },
        features: featuresAt(cur),
      });
      setPendingShot(null);
      say(`RELEASE @${cur} · shooter P#${shooter.trackingId} — M make / X miss`);
    } else if (key === 'm' || key === 'x') {
      const result = key === 'm' ? 'make' : 'miss';
      setEvents((prev) => {
        const shots = prev.filter((e) => e.type === 'shot' && e.keyFrame <= cur);
        if (!shots.length) return prev;
        const target = shots[shots.length - 1];
        const upd = prev.map((e) => e.localId === target.localId
          ? { ...e, source: 'human', endFrame: cur, payload: { ...e.payload, result, endFrame: cur } }
          : e);
        // auto-link waiting assist to this make
        if (result === 'make') {
          const assist = upd.find((e) => e.type === 'assist' && !e.payload.shotReleaseFrame
            && (target.keyFrame - e.keyFrame) / fps <= 3 && e.keyFrame <= target.keyFrame);
          if (assist) {
            assist.payload = {
              ...assist.payload,
              shotReleaseFrame: target.keyFrame,
              shooterTrackingId: target.payload.shooterTrackingId,
            };
          }
        }
        return upd;
      });
      say(`${result.toUpperCase()} @${cur}`);
    } else if (key === 'e') {
      setPendingRebound({ start: cur });
      say(`rebound start (ball hits rim) @${cur} — press W at possession`);
    } else if (key === 'w') {
      const start = pendingRebound?.start ?? cur;
      const reb = nearestPlayerToBall(cur);
      if (!reb) { say('No rebounder near ball - label player first', true); return; }
      const lastShot = [...events].reverse().find((e) => e.type === 'shot' && e.keyFrame <= cur);
      const shooterCls = lastShot
        ? (frames.get(lastShot.keyFrame) ?? []).find((o) => o.trackingId === lastShot.payload.shooterTrackingId)?.cls
        : undefined;
      const rtype = shooterCls && shooterCls === reb.cls ? 'offensive' : 'defensive';
      addEvent({
        type: 'rebound', keyFrame: cur, startFrame: start, endFrame: cur,
        payload: { startFrame: start, endFrame: cur, rebounderTrackingId: reb.trackingId, reboundType: rtype },
        features: featuresAt(cur),
      });
      setPendingRebound(null);
      say(`rebound P#${reb.trackingId} (${rtype}) @${cur}`);
    } else if (key === 'a') {
      const assister = nearestPlayerToBall(cur);
      if (!assister) { say('No passer near ball - label player first', true); return; }
      const make = events.find((e) => e.type === 'shot' && e.payload.result === 'make'
        && e.keyFrame >= cur && (e.keyFrame - cur) / fps <= 3);
      addEvent({
        type: 'assist', keyFrame: cur, startFrame: cur, endFrame: make?.keyFrame ?? null,
        payload: {
          passFrame: cur, shotReleaseFrame: make?.keyFrame ?? null,
          assisterTrackingId: assister.trackingId,
          shooterTrackingId: make?.payload.shooterTrackingId ?? null,
        },
        features: featuresAt(cur),
      });
      say(make ? `assist linked to make @${make.keyFrame}` : 'assist pass — will link to next make within 3s');
    } else if (key === 'b') {
      const blocker = nearestPlayerToBall(cur, { cls: 'player_defense' }) ?? nearestPlayerToBall(cur);
      if (!blocker) { say('No blocker near ball - label player first', true); return; }
      let shooter: ObjectAnnotation | null = null;
      for (let f = cur; f >= Math.max(0, cur - 8) && !shooter; f--) {
        shooter = nearestPlayerToBall(f, { cls: 'player_offense', not: blocker.trackingId })
          ?? nearestPlayerToBall(f, { not: blocker.trackingId });
      }
      addEvent({
        type: 'block', keyFrame: cur, startFrame: cur, endFrame: null,
        payload: {
          blockFrame: cur, blockerTrackingId: blocker.trackingId,
          shooterTrackingId: shooter?.trackingId ?? null,
        },
        features: featuresAt(cur),
      });
      say(`BLOCK P#${blocker.trackingId} on P#${shooter?.trackingId ?? '?'} @${cur}`);
    } else if (key === 'l') {
      const stealer = nearestPlayerToBall(cur);
      if (!stealer) { say('No stealer near ball - label player first', true); return; }
      let loser: ObjectAnnotation | null = null;
      for (let f = cur - 2; f >= Math.max(0, cur - 15) && !loser; f--) {
        loser = nearestPlayerToBall(f, { not: stealer.trackingId });
      }
      addEvent({
        type: 'steal', keyFrame: cur, startFrame: cur, endFrame: null,
        payload: {
          stealFrame: cur, stealerTrackingId: stealer.trackingId,
          loserTrackingId: loser?.trackingId ?? null,
        },
        features: featuresAt(cur),
      });
      say(`STEAL P#${stealer.trackingId} from P#${loser?.trackingId ?? '?'} @${cur}`);
    }
  }, [cur, pendingShot, pendingRebound, events, frames, fps, addEvent, nearestPlayerToBall, featuresAt, say]);

  // ---------- interpolation ----------
  const interpolate = useCallback(() => {
    const sel = curObjects.find((o) => o.id === selId);
    if (!sel || sel.trackingId == null) { say('select a tracked box first', true); return; }
    if (!interpAnchor) {
      setInterpAnchor({ frame: cur, tid: sel.trackingId, cls: sel.cls });
      say(`interp anchor P#${sel.trackingId} @${cur} — go to another frame, select same id, press I`);
      return;
    }
    if (interpAnchor.tid !== sel.trackingId) { say(`anchor is P#${interpAnchor.tid}, selected P#${sel.trackingId}`, true); return; }
    const [f0, f1] = [Math.min(interpAnchor.frame, cur), Math.max(interpAnchor.frame, cur)];
    if (f1 - f0 < 2) { setInterpAnchor(null); return; }
    const a = (frames.get(f0) ?? []).find((o) => o.trackingId === sel.trackingId && o.cls === sel.cls);
    const b = (frames.get(f1) ?? []).find((o) => o.trackingId === sel.trackingId && o.cls === sel.cls);
    if (!a || !b) { say('box missing on one endpoint', true); return; }
    const df = f1 - f0;
    const vx = (b.x + b.w / 2 - (a.x + a.w / 2)) / df;
    const vy = (b.y + b.h / 2 - (a.y + a.h / 2)) / df;
    for (let f = f0 + 1; f < f1; f++) {
      const t = (f - f0) / df;
      const box = {
        x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
        w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t,
      };
      mutateFrame(f, (objs) => {
        const rest = objs.filter((o) => !(o.trackingId === sel.trackingId && o.cls === sel.cls));
        return [...rest, { ...a, id: nid(), ...box, vx, vy, confidence: null }];
      });
    }
    mutateFrame(f0, (objs) => objs.map((o) => (o === a ? { ...o, vx, vy } : o)));
    mutateFrame(f1, (objs) => objs.map((o) => (o === b ? { ...o, vx, vy } : o)));
    say(`interpolated P#${sel.trackingId} across ${df - 1} frames · vx=${vx.toFixed(1)} vy=${vy.toFixed(1)}`);
    setInterpAnchor(null);
  }, [curObjects, selId, interpAnchor, cur, frames, mutateFrame, say]);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
      const v = videoRef.current;
      const k = e.key.toLowerCase();
      if (e.shiftKey) {
        const tools: Record<string, string> = { b: 'ball', p: 'player', r: 'rim', k: 'backboard', n: 'net', c: 'court' };
        if (tools[k]) { setTool(tools[k]); e.preventDefault(); return; }
      }
      if (k === ' ') { e.preventDefault(); v && (v.paused ? v.play() : v.pause()); }
      else if (k === 'arrowright') { e.preventDefault(); v?.pause(); seek(cur + (e.shiftKey ? 10 : 1)); }
      else if (k === 'arrowleft') { e.preventDefault(); v?.pause(); seek(Math.max(0, cur - (e.shiftKey ? 10 : 1))); }
      else if (k === 'v') setTool('select');
      else if (k === 'z') setZoomed((z) => !z);
      else if (k === 't') {
        const sel = curObjects.find((o) => o.id === selId);
        if (!sel) return;
        const val = window.prompt('trackingId', String(sel.trackingId ?? ''));
        if (val != null) mutateFrame(cur, (objs) => objs.map((o) => o.id === selId ? { ...o, trackingId: Number(val) || null } : o));
      } else if (k === 'i') interpolate();
      else if (k === 'backspace' || k === 'delete') {
        if (selEvent) { setEvents((prev) => prev.filter((ev) => ev.localId !== selEvent)); setSelEvent(null); }
        else if (selId) {
          if (court.some((o) => o.id === selId)) setCourt((c) => c.filter((o) => o.id !== selId));
          else mutateFrame(cur, (objs) => objs.filter((o) => o.id !== selId));
          setSelId(null);
        }
      } else if (k === 'enter' && tool === 'court') closeCourtPolygon();
      else if (k === 'escape') { setCourtDraft([]); setSelId(null); setSelEvent(null); setPendingShot(null); setPendingRebound(null); }
      else if (['s', 'r', 'm', 'x', 'e', 'w', 'a', 'b', 'l'].includes(k)) { e.preventDefault(); eventKey(k); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cur, curObjects, selId, selEvent, tool, court, seek, eventKey, interpolate, mutateFrame, closeCourtPolygon]);

  // ---------- save / approve ----------
  const save = async () => {
    setSaving(true);
    const frameData = [...edited].sort((a, b) => a - b).map((f) => ({
      frameNumber: f,
      objects: [...(frames.get(f) ?? []), ...court],
    }));
    const evData = events.map((e) => ({
      type: e.type, keyFrame: e.keyFrame, startFrame: e.startFrame, endFrame: e.endFrame,
      payload: e.payload, features: e.features,
    }));
    const r = await fetch(`/api/videos/${videoId}/labels`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frames: frameData, events: evData }),
    }).then((r) => r.json());
    setSaving(false);
    say(`saved ${r.frames} frames + ${r.events} events (LabelVersion ${String(r.versionId).slice(-6)})`);
  };

  const toggleApprove = async (val: boolean) => {
    setApproved(val);
    const r = await fetch(`/api/videos/${videoId}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: val }),
    }).then((r) => r.json());
    if (val) say(`approved — ${r.newApprovedLabels} labels ready for training`);
  };

  const triggerTraining = async () => {
    const r = await fetch('/api/trigger-training', { method: 'POST' }).then((r) => r.json());
    say(r.started ? `training job ${r.jobId.slice(-6)} started — watch /queue` : r.reason);
  };

  // ---------- render ----------
  if (!meta) return <main className="page">loading…</main>;

  const src = sources.get(cur);
  const frameColor = (o: ObjectAnnotation) =>
    o.id === selId ? '#f0883e' : src === 'human' || o.confidence == null ? '#3fb950' : '#d4a72c';
  const zoomScale = zoomed ? 2 : 1;
  const ball = ballAt(cur);
  const zoomOrigin = zoomed && ball
    ? { x: -(ball.x + ball.w / 2) * scale * 2 + dispSize.w / 2, y: -(ball.y + ball.h / 2) * scale * 2 + dispSize.h / 2 }
    : { x: 0, y: 0 };
  const selObj = allObjects.find((o) => o.id === selId);
  const selEv = events.find((e) => e.localId === selEvent);
  const ppf = tlZoom;

  return (
    <div className="editor">
      {/* left toolbar */}
      <div className="toolbar">
        {[
          ['select', 'V', '▲'], ['ball', '⇧B', 'B'], ['player', '⇧P', 'P'], ['rim', '⇧R', 'R'],
          ['backboard', '⇧K', 'K'], ['net', '⇧N', 'N'], ['court', '⇧C', 'C'],
        ].map(([t, , label]) => (
          <button key={t} title={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)}>{label}</button>
        ))}
        <div style={{ marginTop: 'auto', paddingBottom: 10, textAlign: 'center' }} className="dim">
          <div style={{ fontSize: 10 }}>{tool === 'player' ? (teamCycle === 'player_offense' ? 'OFF' : 'DEF') : ''}</div>
          <button title="zoom 200% (Z)" className={zoomed ? 'active' : ''} onClick={() => setZoomed(!zoomed)}>🔍</button>
        </div>
      </div>

      {/* stage */}
      <div className="stagewrap" ref={wrapRef}>
        <div style={{ position: 'relative', width: dispSize.w, height: dispSize.h, overflow: 'hidden' }}>
          <video
            ref={videoRef}
            src={`/api/videos/${videoId}/file`}
            width={dispSize.w}
            height={dispSize.h}
            style={{
              transform: zoomed ? `translate(${zoomOrigin.x}px, ${zoomOrigin.y}px) scale(2)` : undefined,
              transformOrigin: '0 0',
            }}
            muted
            playsInline
            crossOrigin="anonymous"
          />
          <Stage
            width={dispSize.w} height={dispSize.h}
            scaleX={scale * zoomScale} scaleY={scale * zoomScale}
            x={zoomed ? zoomOrigin.x : 0} y={zoomed ? zoomOrigin.y : 0}
            style={{ position: 'absolute', top: 0, left: 0, cursor: tool === 'select' ? 'default' : 'crosshair' }}
            onMouseDown={onStageMouseDown} onMouseMove={onStageMouseMove} onMouseUp={onStageMouseUp}
            onDblClick={() => tool === 'court' && closeCourtPolygon()}
          >
            <Layer>
              {court.map((o) => o.polygon && (
                <Line key={o.id} points={o.polygon.flatMap((p) => [p.x, p.y])} closed
                  stroke={o.id === selId ? '#f0883e' : '#58a6ff'} strokeWidth={2 / scale / zoomScale}
                  fill="rgba(88,166,255,0.06)" onClick={() => setSelId(o.id)} />
              ))}
              {courtDraft.length > 0 && (
                <Line points={courtDraft.flatMap((p) => [p.x, p.y])}
                  stroke="#58a6ff" strokeWidth={2 / scale / zoomScale} dash={[6, 4]} />
              )}
              {curObjects.map((o) => (
                <Rect
                  key={o.id}
                  x={o.x} y={o.y} width={o.w} height={o.h}
                  stroke={frameColor(o)} strokeWidth={(o.id === selId ? 3 : 1.5) / scale / zoomScale}
                  dash={o.occluded ? [8, 4] : undefined}
                  draggable={tool === 'select'}
                  onClick={() => setSelId(o.id)}
                  onTap={() => setSelId(o.id)}
                  onDragEnd={(e) => mutateFrame(cur, (objs) => objs.map((x) =>
                    x.id === o.id ? { ...x, x: e.target.x(), y: e.target.y() } : x))}
                />
              ))}
              {curObjects.map((o) => (
                <Text key={`t${o.id}`} x={o.x} y={o.y - 16 / scale / zoomScale}
                  text={
                    o.cls === 'ball' ? (o.occluded ? 'BALL?' : 'BALL')
                      : o.cls.startsWith('player')
                        ? `${o.cls === 'player_offense' ? 'O' : o.cls === 'player_defense' ? 'D' : 'P'}#${o.trackingId ?? '?'}${o.jerseyNumber ? ` (${o.jerseyNumber})` : ''}`
                        : o.cls.toUpperCase()
                  }
                  fontSize={13 / scale / zoomScale} fill={frameColor(o)} fontStyle="bold"
                />
              ))}
              {selId && tool === 'select' && selObj && !selObj.polygon && (
                <Circle
                  x={selObj.x + selObj.w} y={selObj.y + selObj.h} radius={5 / scale / zoomScale}
                  fill="#f0883e" draggable
                  onDragEnd={(e) => mutateFrame(cur, (objs) => objs.map((x) =>
                    x.id === selId
                      ? { ...x, w: Math.max(4, e.target.x() - x.x), h: Math.max(4, e.target.y() - x.y) }
                      : x))}
                />
              )}
              {draft && <Rect {...draft} stroke="#f0883e" strokeWidth={2 / scale / zoomScale} dash={[6, 3]} />}
            </Layer>
          </Stage>
          {zoomed && (
            <div className="crosshair" style={{
              left: dispSize.w / 2 - 14, top: dispSize.h / 2 - 14, width: 28, height: 28, borderRadius: 14,
            }} />
          )}
        </div>
      </div>

      {/* right properties panel */}
      <div className="props">
        <h2 style={{ marginTop: 0 }}>{meta.video.name}</h2>
        <div className="dim">frame {cur} / {totalFrames} · {fps.toFixed(2)} fps · {src === 'human' ? '● human' : src === 'teacher' ? '● teacher (yellow)' : '○ unlabeled'}</div>

        <div style={{ display: 'flex', gap: 6, margin: '10px 0' }}>
          <button className="primary" disabled={saving} onClick={save}>Save{edited.size ? ` (${edited.size}f)` : ''}</button>
          <button className="green" onClick={triggerTraining}>Train now</button>
        </div>
        <label className="row" style={{ margin: '6px 0' }}>
          <input type="checkbox" checked={approved} onChange={(e) => toggleApprove(e.target.checked)} />
          &nbsp;Approved for training
        </label>

        {selObj ? (
          <div className="card" style={{ marginTop: 10 }}>
            <label>class</label>
            <select value={selObj.cls} onChange={(e) => mutateFrame(cur, (objs) =>
              objs.map((o) => o.id === selId ? { ...o, cls: e.target.value as any } : o))}>
              {['ball', 'player_offense', 'player_defense', 'player', 'rim', 'backboard', 'net', 'court'].map((c) =>
                <option key={c}>{c}</option>)}
            </select>
            <label>trackingId <kbd>T</kbd></label>
            <input type="number" value={selObj.trackingId ?? ''} onChange={(e) => mutateFrame(cur, (objs) =>
              objs.map((o) => o.id === selId ? { ...o, trackingId: e.target.value === '' ? null : Number(e.target.value) } : o))} />
            <label>jersey #</label>
            <input value={selObj.jerseyNumber ?? ''} onChange={(e) => mutateFrame(cur, (objs) =>
              objs.map((o) => o.id === selId ? { ...o, jerseyNumber: e.target.value || null } : o))} />
            <div className="row" style={{ marginTop: 8, gap: 10 }}>
              {(['visible', 'occluded', 'blurry'] as const).map((flag) => (
                <label key={flag} style={{ margin: 0 }}>
                  <input type="checkbox" checked={!!selObj[flag]} onChange={(e) => mutateFrame(cur, (objs) =>
                    objs.map((o) => o.id === selId ? { ...o, [flag]: e.target.checked } : o))} /> {flag}
                </label>
              ))}
            </div>
            <div className="dim" style={{ marginTop: 6 }}>
              vx {selObj.vx?.toFixed(1) ?? '—'} · vy {selObj.vy?.toFixed(1) ?? '—'}
              {selObj.confidence != null && <> · conf {selObj.confidence.toFixed(2)}</>}
            </div>
          </div>
        ) : selEv ? (
          <div className="card" style={{ marginTop: 10 }}>
            <b>{selEv.type}</b> @ {selEv.keyFrame} <span className="dim">({selEv.source}{selEv.confidence ? ` ${(selEv.confidence * 100) | 0}%` : ''})</span>
            <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 6 }}>{JSON.stringify(selEv.payload, null, 1)}</pre>
            <button onClick={() => { setEvents((p) => p.filter((e) => e.localId !== selEvent)); setSelEvent(null); }}>Delete (⌫)</button>
          </div>
        ) : (
          <div className="dim" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.8 }}>
            <b>Objects</b> <kbd>⇧B</kbd> ball <kbd>⇧P</kbd> player <kbd>⇧R</kbd> rim <kbd>⇧K</kbd> board <kbd>⇧N</kbd> net <kbd>⇧C</kbd> court<br />
            <kbd>T</kbd> id · <kbd>I</kbd> interpolate · <kbd>Z</kbd> zoom · <kbd>⌫</kbd> delete<br />
            <b>Events</b> <kbd>S</kbd> gather <kbd>R</kbd> RELEASE <kbd>M</kbd> make <kbd>X</kbd> miss<br />
            <kbd>E</kbd> reb start <kbd>W</kbd> reb end <kbd>A</kbd> assist <kbd>B</kbd> block <kbd>L</kbd> steal<br />
            <kbd>space</kbd> play · <kbd>←→</kbd> frame step
          </div>
        )}
      </div>

      {/* bottom: transport + event lanes */}
      <div className="timeline-panel">
        <div className="transport">
          <button onClick={() => { const v = videoRef.current; v && (v.paused ? v.play() : v.pause()); }}>⏯</button>
          <button onClick={() => seek(Math.max(0, cur - 1))}>−1f</button>
          <button onClick={() => seek(cur + 1)}>+1f</button>
          <span>f<b>{cur}</b> · {(cur / fps).toFixed(2)}s</span>
          <input type="range" min={0} max={Math.max(totalFrames - 1, 1)} value={cur}
            style={{ flex: 1 }} onChange={(e) => seek(Number(e.target.value))} />
          <span className="dim">lane zoom</span>
          <input type="range" min={0.5} max={8} step={0.5} value={tlZoom} style={{ width: 80 }}
            onChange={(e) => setTlZoom(Number(e.target.value))} />
          {pendingShot && <span style={{ color: '#f0883e' }}>SHOT: gather @{pendingShot.gather} → R</span>}
          {pendingRebound && <span style={{ color: '#f0883e' }}>REB: start @{pendingRebound.start} → W</span>}
        </div>
        <div className="lanes">
          <div style={{ position: 'relative', width: totalFrames * ppf + 120, minHeight: LANES.length * 24 + 4 }}>
            {LANES.map((lane, i) => (
              <div key={lane} style={{
                position: 'absolute', top: i * 24, left: 0, right: 0, height: 24,
                borderBottom: '1px solid #21262d',
              }}
                onClick={(e) => {
                  const x = e.clientX - (e.currentTarget.getBoundingClientRect().left) - 100;
                  if (x > 0) seek(Math.round(x / ppf));
                }}>
                <span style={{
                  position: 'sticky', left: 0, display: 'inline-block', width: 96, paddingLeft: 8,
                  fontSize: 11, color: '#8b949e', background: '#161b22', zIndex: 2, lineHeight: '24px',
                }}>{LANE_LABEL[lane]}</span>
              </div>
            ))}
            {events.map((e) => {
              const lane = LANES.indexOf(e.type);
              if (lane < 0) return null;
              const s = e.startFrame ?? e.keyFrame;
              const en = e.endFrame ?? e.keyFrame + 4;
              return (
                <div key={e.localId}
                  title={`${e.type} @${e.keyFrame}`}
                  onClick={(ev) => { ev.stopPropagation(); setSelEvent(e.localId); setSelId(null); seek(e.keyFrame); }}
                  style={{
                    position: 'absolute', top: lane * 24 + 4, height: 16,
                    left: 100 + s * ppf, width: Math.max((en - s) * ppf, 8),
                    background: e.source === 'human' ? 'rgba(63,185,80,.35)' : 'rgba(212,167,44,.3)',
                    border: `1px solid ${e.localId === selEvent ? '#f0883e' : e.source === 'human' ? '#3fb950' : '#d4a72c'}`,
                    borderRadius: 3, cursor: 'pointer', zIndex: 1,
                  }}>
                  <div style={{
                    position: 'absolute', left: (e.keyFrame - s) * ppf - 1, top: -2, width: 2, height: 18,
                    background: '#f0883e',
                  }} />
                </div>
              );
            })}
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: 100 + cur * ppf, width: 1,
              background: '#f0883e', zIndex: 3, pointerEvents: 'none',
            }} />
          </div>
        </div>
      </div>

      {toast && <div className={`toast ${toast.danger ? '' : 'info'}`}>{toast.msg}</div>}
    </div>
  );
}
