/* ============================================================================
   BALL / AUTOCODE — Timeline Engine
   The timeline is an event database visualized as tracks. Every coded event
   (AI or manual) is a clip on a track. This module owns:
     - the event DB + track registry
     - a virtualized canvas renderer (only visible rows/clips are drawn)
     - navigation (scroll / cursor-centered zoom / pan / scrub)
     - interaction (select, multi-select, drag, resize, cross-track drag,
       copy/paste, delete, undo/redo, keyboard shortcuts)
     - video synchronization (click→seek, scrub→frame, playhead follows video)
     - track management (create/rename/delete/collapse/reorder/hide/lock)
     - ★ Track Playback: double-click a track → playlist of all its clips
   Exposes window.TL.
   ========================================================================== */
(function () {
  "use strict";

  const TL = (window.TL = {});

  /* ---------- constants (match existing look exactly) ---------- */
  const ROW_H = 22, COLLAPSED_H = 8, RULER_H = 18, CLIP_TOP = 5, CLIP_H = 12;
  const C = {
    body: "#1b1b1d", ruler: "#202124", rulerText: "#7f868d",
    border: "#2a2b2e", laneHome: "#7d1f1f",
    clip: "#e7e7e7", clipHome: "#ffdede",
    playhead: "#ff3b30", select: "#4f9cf9", playlistActive: "#f59e0b",
    hover: "rgba(255,255,255,0.25)"
  };
  const GAME_LEN = 20 * 60;          // timeline time base: one 20:00 half
  const MAX_PPS = 240;               // px per second at max zoom (frame-level)
  const UNDO_CAP = 200;

  /* ---------- state ---------- */
  const tracks = [];                 // ordered array of track objects
  const trackById = new Map();
  const events = new Map();          // id -> event
  const byTrack = new Map();         // trackId -> events sorted by gameSec
  let evSeq = 1, trSeq = 1;

  const view = { scrollX: 0, pps: 0, scrollY: 0, minPps: 0 };
  const selection = new Set();
  let hoverId = null, hoverEdge = null;
  let clipboard = [];
  const undoStack = [], redoStack = [];

  let playheadSec = 0, liveEdgeSec = 0, liveMode = true;
  let playlist = null;               // {label, items, idx, loop, speed}
  TL.preRoll = 3; TL.postRoll = 3;   // configurable playlist padding (seconds)

  let canvas, ctx, namesEl, sideEl, video, onCount;
  let dpr = 1, laneW = 0, laneH = 0, dirty = true;

  /* ======================= data model ======================= */

  function sortTrack(tid) {
    (byTrack.get(tid) || []).sort((a, b) => a.gameSec - b.gameSec);
  }

  TL.addTrack = function (name, opts = {}) {
    const t = {
      id: "t" + trSeq++, name, teamRow: !!opts.teamRow, cls: opts.cls || "",
      collapsed: false, hidden: false, locked: false
    };
    if (opts.index != null) tracks.splice(opts.index, 0, t); else tracks.push(t);
    trackById.set(t.id, t); byTrack.set(t.id, []);
    rebuildNames(); dirty = true;
    return t;
  };

  function trackByName(name) { return tracks.find(t => t.name === name); }

  function makeEvent(o) {
    const dur = o.duration != null ? o.duration : 4;
    const gameSec = Math.max(0, Math.min(GAME_LEN - dur, o.gameSec || 0));
    return {
      id: "e" + evSeq++,
      label: o.label || "Event",
      trackId: o.trackId,
      team: o.team || "",
      players: o.players || [],
      quarter: o.quarter || 1,
      gameClock: o.gameClock || fmtGame(GAME_LEN - gameSec),
      wallTime: o.wallTime || null,
      gameSec, duration: dur,
      videoStart: o.videoStart != null ? o.videoStart : mapToVideo(gameSec),
      videoEnd: o.videoEnd != null ? o.videoEnd : mapToVideo(gameSec + dur),
      confidence: o.confidence != null ? o.confidence : 100,
      source: o.source || "manual",
      overridden: false,
      metadata: o.metadata || {}
    };
  }

  function insertEvent(ev) {
    events.set(ev.id, ev);
    const arr = byTrack.get(ev.trackId);
    if (arr) { arr.push(ev); sortTrack(ev.trackId); }
    dirty = true; countChanged();
  }
  function removeEvent(ev) {
    events.delete(ev.id);
    const arr = byTrack.get(ev.trackId);
    if (arr) { const i = arr.indexOf(ev); if (i >= 0) arr.splice(i, 1); }
    selection.delete(ev.id);
    dirty = true; countChanged();
  }

  /* AI live events from the sim engine (or the real perception stack). */
  TL.addLiveEvent = function (o) {
    let t = trackByName(o.track);
    if (!t) t = TL.addTrack(o.track);
    const now = video ? video.currentTime : 0;
    const ev = makeEvent({
      ...o, trackId: t.id, source: "ai",
      // capture the real footage moment the AI fired on
      videoStart: Math.max(0, now - 1.5),
      videoEnd: Math.min(vidDur(), now + 0.5)
    });
    insertEvent(ev);
    return ev;
  };

  TL.getAllEvents = function () {
    return [...events.values()].map(e => ({
      ...e, trackName: (trackById.get(e.trackId) || {}).name || e.trackId
    }));
  };
  TL.eventCount = function () { return events.size; };

  /* Bulk insert used by stress tests / imports. */
  TL.bulkLoad = function (list) {
    list.forEach(o => {
      let t = trackByName(o.track) || TL.addTrack(o.track);
      insertEvent(makeEvent({ ...o, trackId: t.id }));
    });
  };

  /* ======================= time mapping ======================= */
  function vidDur() { return (video && video.duration) ? video.duration : 12; }
  function mapToVideo(gameSec) { return (gameSec / GAME_LEN) * vidDur(); }
  function mapFromVideo(vt) { return (vt / vidDur()) * GAME_LEN; }
  function fmtGame(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ":" + String(sec).padStart(2, "0");
  }
  function fmtRuler(s, step) {
    const m = Math.floor(s / 60), sec = s % 60;
    if (step >= 1) return String(m).padStart(2, "0") + ":" + String(Math.floor(sec)).padStart(2, "0");
    return String(m).padStart(2, "0") + ":" + sec.toFixed(2).padStart(5, "0");
  }

  /* ======================= undo / redo ======================= */
  function pushCmd(cmd, alreadyDone = true) {
    if (!alreadyDone) cmd.redo();
    undoStack.push(cmd);
    if (undoStack.length > UNDO_CAP) undoStack.shift();
    redoStack.length = 0;
  }
  TL.undo = function () {
    const c = undoStack.pop();
    if (c) { c.undo(); redoStack.push(c); dirty = true; countChanged(); }
  };
  TL.redo = function () {
    const c = redoStack.pop();
    if (c) { c.redo(); undoStack.push(c); dirty = true; countChanged(); }
  };

  function cmdCreate(evs) {
    return {
      redo() { evs.forEach(insertEvent); },
      undo() { evs.forEach(removeEvent); }
    };
  }
  function cmdDelete(evs) {
    return {
      redo() { evs.forEach(removeEvent); },
      undo() { evs.forEach(insertEvent); }
    };
  }
  function cmdMove(items) {   // items: [{ev, from:{gameSec,trackId,duration}, to:{...}}]
    const apply = (key) => {
      items.forEach(({ ev, [key]: s }) => {
        const oldTrack = ev.trackId;
        ev.gameSec = s.gameSec; ev.duration = s.duration;
        ev.gameClock = fmtGame(GAME_LEN - s.gameSec);
        if (s.trackId !== ev.trackId) {
          const a = byTrack.get(ev.trackId); const i = a.indexOf(ev); if (i >= 0) a.splice(i, 1);
          ev.trackId = s.trackId; byTrack.get(s.trackId).push(ev);
        }
        if (ev.source === "ai") ev.overridden = true;   // manual override of AI event
        sortTrack(oldTrack); sortTrack(ev.trackId);
      });
      dirty = true;
    };
    return { redo() { apply("to"); }, undo() { apply("from"); } };
  }

  /* ======================= selection / clipboard ======================= */
  function selectOnly(id) { selection.clear(); if (id) selection.add(id); dirty = true; }

  TL.copy = function () {
    clipboard = [...selection].map(id => {
      const e = events.get(id);
      return { ...e, players: [...e.players], metadata: { ...e.metadata } };
    });
  };
  TL.paste = function () {
    if (!clipboard.length) return;
    const minSec = Math.min(...clipboard.map(e => e.gameSec));
    const evs = clipboard.map(src => makeEvent({
      ...src, gameSec: playheadSec + (src.gameSec - minSec),
      source: "manual", label: src.label
    }));
    pushCmd(cmdCreate(evs), false);
    selection.clear(); evs.forEach(e => selection.add(e.id));
    dirty = true;
  };
  TL.deleteSelection = function () {
    const evs = [...selection].map(id => events.get(id))
      .filter(e => e && !trackById.get(e.trackId).locked);
    if (evs.length) pushCmd(cmdDelete(evs), false);
  };

  TL.createEvent = function (trackId, gameSec, label) {
    const t = trackById.get(trackId);
    if (!t || t.locked) return null;
    const ev = makeEvent({ trackId, gameSec, label: label || "New Event", duration: 4 });
    pushCmd(cmdCreate([ev]), false);
    selectOnly(ev.id);
    return ev;
  };

  /* ======================= track management ======================= */
  TL.renameTrack = function (t, name) { t.name = name; rebuildNames(); dirty = true; };
  TL.deleteTrack = function (t) {
    const evs = [...(byTrack.get(t.id) || [])];
    const idx = tracks.indexOf(t);
    pushCmd({
      redo() {
        evs.forEach(removeEvent);
        const i = tracks.indexOf(t); if (i >= 0) tracks.splice(i, 1);
        trackById.delete(t.id); rebuildNames(); dirty = true;
      },
      undo() {
        tracks.splice(Math.min(idx, tracks.length), 0, t);
        trackById.set(t.id, t); byTrack.set(t.id, []);
        evs.forEach(insertEvent); rebuildNames(); dirty = true;
      }
    }, false);
  };
  TL.moveTrack = function (from, to) {
    const [t] = tracks.splice(from, 1);
    tracks.splice(to, 0, t);
    rebuildNames(); dirty = true;
  };

  /* ======================= playlist (★ flagship) ======================= */
  const hud = {};
  function ensureHud() {
    if (hud.root) return;
    const r = document.createElement("div");
    r.id = "playlist-hud";
    r.innerHTML =
      '<div class="pl-title" id="pl-title"></div>' +
      '<div class="pl-row">' +
      '<button class="vc-btn" id="pl-prev" title="Previous clip">⏮</button>' +
      '<button class="vc-btn" id="pl-pause" title="Pause">⏸</button>' +
      '<button class="vc-btn" id="pl-next" title="Next clip">⏭</button>' +
      '<button class="vc-btn pl-speed" id="pl-speed" title="Playback speed">1×</button>' +
      '<button class="vc-btn" id="pl-loop" title="Loop playlist">⟳</button>' +
      '<button class="vc-btn pl-return" id="pl-return" title="Return to full game">Full Game</button>' +
      "</div>";
    const wrap = document.querySelector(".video-wrap");
    wrap.appendChild(r);
    hud.root = r;
    hud.title = r.querySelector("#pl-title");
    hud.pause = r.querySelector("#pl-pause");
    hud.speed = r.querySelector("#pl-speed");
    hud.loop = r.querySelector("#pl-loop");
    r.querySelector("#pl-prev").onclick = () => playlistStep(-1);
    r.querySelector("#pl-next").onclick = () => playlistStep(1);
    hud.pause.onclick = () => {
      if (video.paused) { video.play(); hud.pause.textContent = "⏸"; }
      else { video.pause(); hud.pause.textContent = "▶"; }
    };
    hud.speed.onclick = () => {
      const speeds = [0.5, 1, 1.5, 2];
      playlist.speed = speeds[(speeds.indexOf(playlist.speed) + 1) % speeds.length];
      video.playbackRate = playlist.speed;
      hud.speed.textContent = playlist.speed + "×";
    };
    hud.loop.onclick = () => {
      playlist.loop = !playlist.loop;
      hud.loop.style.color = playlist.loop ? "#f59e0b" : "";
    };
    r.querySelector("#pl-return").onclick = TL.exitPlaylist;
  }

  TL.playTrack = function (t) {
    const items = [...(byTrack.get(t.id) || [])];
    if (!items.length) return flashMsg(`"${t.name}" has no clips`);
    startPlaylist(t.name, items);
  };
  TL.playSelection = function () {
    const items = [...selection].map(id => events.get(id)).filter(Boolean)
      .sort((a, b) => a.gameSec - b.gameSec);
    if (items.length) startPlaylist("Selection", items);
  };

  function startPlaylist(label, items) {
    ensureHud();
    playlist = { label, items, idx: 0, loop: false, speed: 1 };
    liveMode = false;
    video.loop = false;
    hud.root.classList.add("show");
    hud.speed.textContent = "1×"; hud.loop.style.color = ""; hud.pause.textContent = "⏸";
    playClip(0);
  }
  function playClip(i) {
    const cl = playlist.items[i];
    playlist.idx = i;
    const start = Math.max(0, cl.videoStart - TL.preRoll);
    playlist.endT = Math.min(vidDur() - 0.05, cl.videoEnd + TL.postRoll);
    video.currentTime = start;
    video.playbackRate = playlist.speed;
    video.play();
    hud.title.textContent = `▶ ${playlist.label} — clip ${i + 1}/${playlist.items.length} · ${cl.label} · Q${cl.quarter} ${cl.gameClock}`;
    // keep the active clip visible on the timeline
    const px = (cl.gameSec - view.scrollX) * view.pps;
    if (px < 0 || px > laneW - 40) view.scrollX = Math.max(0, cl.gameSec - (laneW / view.pps) * 0.3);
    dirty = true;
  }
  function playlistStep(d) {
    if (!playlist) return;
    let i = playlist.idx + d;
    if (i < 0) i = playlist.items.length - 1;
    if (i >= playlist.items.length) {
      if (playlist.loop) i = 0;
      else return TL.exitPlaylist();
    }
    playClip(i);
  }
  TL.exitPlaylist = function () {
    if (!playlist) return;
    playlist = null;
    hud.root && hud.root.classList.remove("show");
    video.playbackRate = 1; video.loop = true; video.play();
    liveMode = true; dirty = true;
  };

  /* transient message, styled like the clock bug */
  let msgTimer = null;
  function flashMsg(text) {
    let el = document.getElementById("tl-msg");
    if (!el) {
      el = document.createElement("div"); el.id = "tl-msg";
      document.querySelector(".video-wrap").appendChild(el);
    }
    el.textContent = text; el.classList.add("show");
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  /* ======================= names column (DOM) ======================= */
  function rebuildNames() {
    if (!namesEl) return;
    namesEl.innerHTML = "";
    visibleTracks().forEach(t => {
      const d = document.createElement("div");
      d.className = "tl-name";
      d.style.height = (t.collapsed ? COLLAPSED_H : ROW_H) + "px";
      if (t.teamRow) d.style.background = C.laneHome;
      if (t.cls === "team-away") d.style.background = "#111";
      d.dataset.tid = t.id;
      d.textContent = t.collapsed ? "" : t.name;
      if (t.locked && !t.collapsed) d.textContent += " 🔒";
      d.title = t.name + " — double-click to play all clips";
      d.addEventListener("dblclick", () => TL.playTrack(t));
      d.addEventListener("contextmenu", e => { e.preventDefault(); trackMenu(e, t); });
      d.addEventListener("mousedown", e => beginTrackDrag(e, t, d));
      namesEl.appendChild(d);
    });
  }
  function visibleTracks() { return tracks.filter(t => !t.hidden); }

  /* drag name cell to reorder */
  function beginTrackDrag(e, t, cell) {
    if (e.button !== 0) return;
    const startY = e.clientY; let moved = false;
    const move = ev => {
      if (Math.abs(ev.clientY - startY) < 6 && !moved) return;
      moved = true;
      cell.style.opacity = 0.4;
      const vis = visibleTracks();
      const rowAt = Math.max(0, Math.min(vis.length - 1,
        Math.floor((ev.clientY - namesEl.getBoundingClientRect().top + view.scrollY) / ROW_H)));
      const target = vis[rowAt];
      if (target && target !== t) {
        TL.moveTrack(tracks.indexOf(t), tracks.indexOf(target));
      }
    };
    const up = () => {
      cell.style.opacity = "";
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /* inline rename */
  function renameInline(t) {
    const cell = namesEl.querySelector(`[data-tid="${t.id}"]`);
    if (!cell) return;
    cell.innerHTML = "";
    const inp = document.createElement("input");
    inp.className = "tl-rename"; inp.value = t.name;
    cell.appendChild(inp); inp.focus(); inp.select();
    const done = ok => {
      if (ok && inp.value.trim()) TL.renameTrack(t, inp.value.trim());
      else rebuildNames();
    };
    inp.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    });
    inp.addEventListener("blur", () => done(true));
  }

  /* ======================= context menus ======================= */
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function showMenu(x, y, items) {
    closeMenu();
    menuEl = document.createElement("div");
    menuEl.className = "tl-menu";
    items.forEach(it => {
      if (it === "-") {
        const s = document.createElement("div"); s.className = "tl-menu-sep";
        menuEl.appendChild(s); return;
      }
      const d = document.createElement("div");
      d.className = "tl-menu-item"; d.textContent = it.label;
      d.onclick = () => { closeMenu(); it.fn(); };
      menuEl.appendChild(d);
    });
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  }
  window.addEventListener("mousedown", e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
  }, true);

  function trackMenu(e, t) {
    const hiddenCount = tracks.filter(x => x.hidden).length;
    showMenu(e.clientX, e.clientY, [
      { label: "▶ Play All Clips", fn: () => TL.playTrack(t) },
      "-",
      { label: "Rename", fn: () => renameInline(t) },
      { label: "New Track", fn: () => { const n = TL.addTrack("New Track", { index: tracks.indexOf(t) + 1 }); renameInline(n); } },
      { label: "Delete Track", fn: () => TL.deleteTrack(t) },
      "-",
      { label: t.collapsed ? "Expand" : "Collapse", fn: () => { t.collapsed = !t.collapsed; rebuildNames(); dirty = true; } },
      { label: t.locked ? "Unlock" : "Lock", fn: () => { t.locked = !t.locked; rebuildNames(); dirty = true; } },
      { label: "Hide", fn: () => { t.hidden = true; rebuildNames(); dirty = true; } },
      ...(hiddenCount ? [{ label: `Show ${hiddenCount} Hidden`, fn: () => { tracks.forEach(x => x.hidden = false); rebuildNames(); dirty = true; } }] : [])
    ]);
  }

  function laneMenu(e, hit) {
    const items = [];
    if (hit && hit.ev) {
      if (!selection.has(hit.ev.id)) selectOnly(hit.ev.id);
      items.push(
        { label: "▶ Play Clip", fn: () => startPlaylist(hit.ev.label, [hit.ev]) },
        { label: "Duplicate", fn: () => { TL.copy(); TL.paste(); } },
        { label: "Delete", fn: TL.deleteSelection },
      );
      if (selection.size > 1) items.unshift({ label: `▶ Play ${selection.size} Selected`, fn: TL.playSelection });
    } else if (hit) {
      const sec = xToSec(hit.x);
      items.push({ label: "New Event Here", fn: () => TL.createEvent(hit.track.id, sec) });
    }
    if (items.length) showMenu(e.clientX, e.clientY, items);
  }

  /* ======================= geometry / hit testing ======================= */
  function xToSec(x) { return view.scrollX + x / view.pps; }
  function secToX(s) { return (s - view.scrollX) * view.pps; }

  function rowLayout() {
    // returns [{track, y, h}] in visual order (virtualization uses this)
    const out = []; let y = 0;
    for (const t of visibleTracks()) {
      const h = t.collapsed ? COLLAPSED_H : ROW_H;
      out.push({ track: t, y, h });
      y += h;
    }
    return out;
  }
  function totalRowsH() { return rowLayout().reduce((s, r) => s + r.h, 0); }

  function hitTest(x, y) {
    // y is canvas-space below ruler
    const rows = rowLayout();
    const yy = y + view.scrollY;
    const row = rows.find(r => yy >= r.y && yy < r.y + r.h);
    if (!row) return null;
    const sec = xToSec(x);
    const arr = byTrack.get(row.track.id) || [];
    // scan visible clips (arrays are small per track; fine even at scale
    // because we bail via binary search bounds)
    let found = null, edge = null;
    for (let i = lowerBound(arr, view.scrollX - 60); i < arr.length; i++) {
      const ev = arr[i];
      if (ev.gameSec > view.scrollX + laneW / view.pps + 60) break;
      const px = secToX(ev.gameSec);
      const pw = Math.max(3, ev.duration * view.pps);
      if (x >= px - 3 && x <= px + pw + 3) {
        found = ev;
        if (pw >= 14) {
          if (Math.abs(x - px) <= 4) edge = "l";
          else if (Math.abs(x - (px + pw)) <= 4) edge = "r";
        }
      }
    }
    return { track: row.track, ev: found, edge, x, sec };
  }
  function lowerBound(arr, sec) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].gameSec < sec) lo = m + 1; else hi = m; }
    return Math.max(0, lo - 1);
  }

  /* ======================= rendering (rAF, virtualized) ======================= */
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    laneW = r.width; laneH = r.height;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view.minPps = laneW / GAME_LEN;
    if (!view.pps) view.pps = view.minPps;
    view.pps = Math.max(view.minPps, view.pps);
    dirty = true;
  }

  function clampView() {
    const spanSec = laneW / view.pps;
    view.scrollX = Math.max(0, Math.min(GAME_LEN - spanSec, view.scrollX));
    const maxY = Math.max(0, totalRowsH() - (laneH - RULER_H));
    view.scrollY = Math.max(0, Math.min(maxY, view.scrollY));
  }

  function draw() {
    clampView();
    ctx.clearRect(0, 0, laneW, laneH);
    ctx.fillStyle = C.body; ctx.fillRect(0, 0, laneW, laneH);

    /* rows + clips (virtualized: only visible) */
    const rows = rowLayout();
    const viewTop = view.scrollY, viewBot = view.scrollY + laneH - RULER_H;
    const t0 = view.scrollX, t1 = view.scrollX + laneW / view.pps;

    for (const r of rows) {
      if (r.y + r.h < viewTop || r.y > viewBot) continue;   // vertical cull
      const y = RULER_H + r.y - view.scrollY;
      if (r.track.teamRow) { ctx.fillStyle = C.laneHome; ctx.fillRect(0, y, laneW, r.h); }
      ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + r.h - 0.5); ctx.lineTo(laneW, y + r.h - 0.5); ctx.stroke();
      if (r.track.collapsed) continue;

      const arr = byTrack.get(r.track.id) || [];
      for (let i = lowerBound(arr, t0 - 120); i < arr.length; i++) {
        const ev = arr[i];
        if (ev.gameSec > t1) break;                          // horizontal cull
        const px = secToX(ev.gameSec);
        const pw = Math.max(3, ev.duration * view.pps);
        if (px + pw < 0) continue;
        const isSel = selection.has(ev.id);
        const isActive = playlist && playlist.items[playlist.idx] === ev;
        ctx.fillStyle = r.track.teamRow ? C.clipHome : C.clip;
        if (ev.id === hoverId && !isSel) ctx.fillStyle = "#ffffff";
        ctx.fillRect(px, y + CLIP_TOP, pw, CLIP_H);
        if (isSel || isActive) {
          ctx.strokeStyle = isActive ? C.playlistActive : C.select;
          ctx.lineWidth = 2;
          ctx.strokeRect(px - 1, y + CLIP_TOP - 1, pw + 2, CLIP_H + 2);
        }
        if (pw > 46 && view.pps > 2) {                      // label at deep zoom
          ctx.fillStyle = r.track.teamRow ? "#4d0f0f" : "#333";
          ctx.font = "8px -apple-system, sans-serif";
          ctx.fillText(ev.label.slice(0, Math.floor(pw / 5)), px + 2, y + CLIP_TOP + 9);
        }
      }
    }

    /* ruler on top (sticky) */
    ctx.fillStyle = C.ruler; ctx.fillRect(0, 0, laneW, RULER_H);
    ctx.strokeStyle = C.border;
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(laneW, RULER_H - 0.5); ctx.stroke();
    const steps = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 240, 300, 600];
    const step = steps.find(s => s * view.pps >= 56) || 600;
    ctx.fillStyle = C.rulerText; ctx.font = "9px -apple-system, sans-serif";
    for (let s = Math.floor(t0 / step) * step; s <= t1; s += step) {
      const x = secToX(s);
      ctx.fillRect(x, RULER_H - 4, 1, 4);
      ctx.fillText(fmtRuler(s, step), x + 3, 12);
    }

    /* playhead */
    const phX = secToX(playheadSec);
    if (phX >= 0 && phX <= laneW) {
      ctx.fillStyle = C.playhead;
      ctx.fillRect(phX - 0.5, 0, 2, laneH);
    }

    /* sync names column vertical position */
    namesEl.style.transform = `translateY(${-view.scrollY}px)`;
  }

  function frame() {
    if (dirty) { dirty = false; draw(); }
    requestAnimationFrame(frame);
  }

  /* ======================= input: canvas ======================= */
  let drag = null;   // {mode:'pan'|'move'|'resize'|'scrub', ...}

  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // zoom centered on cursor
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const secAt = xToSec(mx);
      const factor = Math.exp(-e.deltaY * 0.0022);
      view.pps = Math.max(view.minPps, Math.min(MAX_PPS, view.pps * factor));
      view.scrollX = secAt - mx / view.pps;
    } else if (e.shiftKey) {
      view.scrollX += (e.deltaY + e.deltaX) / view.pps;
    } else {
      view.scrollX += e.deltaX / view.pps;
      view.scrollY += e.deltaY;
    }
    dirty = true;
  }

  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onMouseDown(e) {
    if (e.button === 2) return;
    const p = canvasPos(e);
    canvas.focus();

    if (p.y <= RULER_H) {          // scrub
      drag = { mode: "scrub" };
      scrubTo(p.x);
      return;
    }
    const hit = hitTest(p.x, p.y - RULER_H);
    if (hit && hit.ev) {
      const locked = trackById.get(hit.ev.trackId).locked;
      // selection semantics
      if (e.metaKey || e.ctrlKey) {
        selection.has(hit.ev.id) ? selection.delete(hit.ev.id) : selection.add(hit.ev.id);
      } else if (e.shiftKey && selection.size) {
        // range select within the same track
        const arr = byTrack.get(hit.ev.trackId) || [];
        const anchor = arr.find(ev => selection.has(ev.id));
        if (anchor) {
          const [a, b] = [anchor.gameSec, hit.ev.gameSec].sort((x, y) => x - y);
          arr.forEach(ev => { if (ev.gameSec >= a && ev.gameSec <= b) selection.add(ev.id); });
        } else selection.add(hit.ev.id);
      } else if (!selection.has(hit.ev.id)) {
        selectOnly(hit.ev.id);
      }
      dirty = true;

      // video sync: clicking a clip immediately seeks the player
      liveMode = false;
      video.currentTime = Math.max(0, hit.ev.videoStart);
      playheadSec = hit.ev.gameSec;

      if (!locked) {
        const items = [...selection].map(id => events.get(id)).filter(Boolean)
          .filter(ev => !trackById.get(ev.trackId).locked)
          .map(ev => ({ ev, from: { gameSec: ev.gameSec, trackId: ev.trackId, duration: ev.duration } }));
        drag = {
          mode: hit.edge ? "resize" : "move",
          edge: hit.edge, items, startX: p.x, startY: p.y, anchor: hit.ev, moved: false
        };
      }
    } else {
      if (!e.shiftKey && !e.metaKey) selectOnly(null);
      drag = { mode: "pan", startX: p.x, startY: p.y, sx: view.scrollX, sy: view.scrollY };
    }
  }

  function scrubTo(x) {
    playheadSec = Math.max(0, Math.min(GAME_LEN, xToSec(x)));
    liveMode = false;
    if (playlist) TL.exitPlaylist();
    video.currentTime = mapToVideo(playheadSec);   // real-time frame update
    dirty = true;
  }

  function onMouseMove(e) {
    const p = canvasPos(e);
    if (drag) {
      if (drag.mode === "scrub") { scrubTo(p.x); return; }
      if (drag.mode === "pan") {
        view.scrollX = drag.sx - (p.x - drag.startX) / view.pps;
        view.scrollY = drag.sy - (p.y - drag.startY);
        dirty = true; return;
      }
      const dSec = (p.x - drag.startX) / view.pps;
      if (Math.abs(p.x - drag.startX) + Math.abs(p.y - drag.startY) > 3) drag.moved = true;
      if (!drag.moved) return;

      if (drag.mode === "move") {
        // cross-track: what row is the cursor over?
        const hitRow = hitTest(p.x, p.y - RULER_H);
        const dTrack = hitRow && hitRow.track && !hitRow.track.locked && !hitRow.track.collapsed
          ? hitRow.track.id : null;
        drag.items.forEach(it => {
          it.ev.gameSec = Math.max(0, Math.min(GAME_LEN - it.ev.duration, it.from.gameSec + dSec));
          it.ev.gameClock = fmtGame(GAME_LEN - it.ev.gameSec);
          if (dTrack && drag.items.length === 1 && it.ev.trackId !== dTrack) {
            const a = byTrack.get(it.ev.trackId), i = a.indexOf(it.ev);
            if (i >= 0) a.splice(i, 1);
            it.ev.trackId = dTrack; byTrack.get(dTrack).push(it.ev); sortTrack(dTrack);
          }
        });
        dirty = true;
      } else if (drag.mode === "resize") {
        drag.items.forEach(it => {
          if (drag.edge === "r") {
            it.ev.duration = Math.max(0.2, it.from.duration + dSec);
          } else {
            const end = it.from.gameSec + it.from.duration;
            it.ev.gameSec = Math.max(0, Math.min(end - 0.2, it.from.gameSec + dSec));
            it.ev.duration = end - it.ev.gameSec;
            it.ev.gameClock = fmtGame(GAME_LEN - it.ev.gameSec);
          }
        });
        dirty = true;
      }
    } else {
      const hit = p.y > RULER_H ? hitTest(p.x, p.y - RULER_H) : null;
      const newHover = hit && hit.ev ? hit.ev.id : null;
      if (newHover !== hoverId) { hoverId = newHover; dirty = true; }
      canvas.style.cursor = p.y <= RULER_H ? "col-resize"
        : hit && hit.edge ? "ew-resize"
        : hit && hit.ev ? "pointer" : "default";
    }
  }

  function onMouseUp() {
    if (drag && (drag.mode === "move" || drag.mode === "resize") && drag.moved) {
      drag.items.forEach(it => {
        it.to = { gameSec: it.ev.gameSec, trackId: it.ev.trackId, duration: it.ev.duration };
        it.ev.gameClock = fmtGame(GAME_LEN - it.ev.gameSec);
        if (it.ev.source === "ai") it.ev.overridden = true;
        // keep sorted after edits
        sortTrack(it.from.trackId); sortTrack(it.ev.trackId);
        // videoStart/End follow proportionally for manual moves
        it.ev.videoStart = mapToVideo(it.ev.gameSec);
        it.ev.videoEnd = mapToVideo(it.ev.gameSec + it.ev.duration);
      });
      pushCmd(cmdMove(drag.items));
    }
    drag = null;
  }

  function onDblClick(e) {
    const p = canvasPos(e);
    if (p.y <= RULER_H) return;
    const hit = hitTest(p.x, p.y - RULER_H);
    if (hit && hit.ev) startPlaylist(hit.ev.label, [hit.ev]);
    else if (hit) TL.createEvent(hit.track.id, xToSec(p.x));
  }

  /* ======================= keyboard ======================= */
  function onKey(e) {
    if (/input|textarea/i.test(document.activeElement.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "z") { e.preventDefault(); e.shiftKey ? TL.redo() : TL.undo(); }
    else if (mod && e.key === "c") { e.preventDefault(); TL.copy(); }
    else if (mod && e.key === "v") { e.preventDefault(); TL.paste(); }
    else if (mod && e.key === "a") {
      e.preventDefault();
      selection.clear(); events.forEach(ev => selection.add(ev.id)); dirty = true;
    }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); TL.deleteSelection(); }
    else if (e.key === "Escape") {
      if (playlist) TL.exitPlaylist();
      else { selectOnly(null); liveMode = true; }
    }
    else if (e.key === "Enter" && selection.size) { e.preventDefault(); TL.playSelection(); }
    else if (e.key === "ArrowLeft" && playlist) playlistStep(-1);
    else if (e.key === "ArrowRight" && playlist) playlistStep(1);
    else if (e.key === "+" || e.key === "=") { zoomAtCenter(1.4); }
    else if (e.key === "-") { zoomAtCenter(1 / 1.4); }
    else if (e.key === "0") { view.pps = view.minPps; view.scrollX = 0; dirty = true; }
    else if (e.key === " ") {
      e.preventDefault();
      video.paused ? video.play() : video.pause();
      if (hud.pause) hud.pause.textContent = video.paused ? "▶" : "⏸";
    }
  }
  function zoomAtCenter(f) {
    const secAt = xToSec(laneW / 2);
    view.pps = Math.max(view.minPps, Math.min(MAX_PPS, view.pps * f));
    view.scrollX = secAt - (laneW / 2) / view.pps;
    dirty = true;
  }

  /* ======================= video sync loop ======================= */
  function onTimeUpdate() {
    if (playlist) {
      // auto-advance when clip window ends
      if (video.currentTime >= playlist.endT || video.ended) playlistStep(1);
      const cl = playlist.items[playlist.idx];
      if (cl) {
        const span = Math.max(0.01, playlist.endT - Math.max(0, cl.videoStart - TL.preRoll));
        const frac = Math.max(0, Math.min(1, (video.currentTime - Math.max(0, cl.videoStart - TL.preRoll)) / span));
        playheadSec = cl.gameSec + frac * cl.duration;
        dirty = true;
      }
    } else if (!liveMode) {
      // playing the video moves the playhead
      playheadSec = mapFromVideo(video.currentTime);
      dirty = true;
    }
  }

  /* live edge from the capture/sim engine */
  TL.setLiveEdge = function (sec) {
    liveEdgeSec = sec;
    if (liveMode && !playlist) { playheadSec = sec; dirty = true; }
  };
  TL.isLive = function () { return liveMode; };
  TL.getTracks = function () { return tracks; };
  TL.benchDraw = function (n) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { view.scrollY = (view.scrollY + 7) % 500; draw(); }
    return (performance.now() - t0) / n;
  };
  TL.debug = function () {
    return {
      pps: view.pps, minPps: view.minPps, scrollX: view.scrollX, scrollY: view.scrollY,
      events: events.size, tracks: tracks.length, selection: selection.size,
      undo: undoStack.length, redo: redoStack.length,
      playlist: playlist ? { idx: playlist.idx, n: playlist.items.length, label: playlist.label } : null,
      drag: drag ? { mode: drag.mode, items: drag.items ? drag.items.length : 0, startX: drag.startX, moved: drag.moved } : null,
      liveMode, playheadSec
    };
  };

  function countChanged() { if (onCount) onCount(events.size); }

  /* ======================= init ======================= */
  TL.init = function (opts) {
    canvas = opts.canvas; ctx = canvas.getContext("2d");
    namesEl = opts.namesEl; sideEl = opts.sideEl || namesEl.parentElement;
    video = opts.video; onCount = opts.onCount || null;
    canvas.tabIndex = 0;

    resize();
    new ResizeObserver(resize).observe(canvas);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("contextmenu", e => {
      e.preventDefault();
      const p = canvasPos(e);
      laneMenu(e, p.y > RULER_H ? hitTest(p.x, p.y - RULER_H) : null);
    });
    window.addEventListener("keydown", onKey);
    video.addEventListener("timeupdate", onTimeUpdate);
    // finer-grained sync than timeupdate for smooth playlist advance
    setInterval(() => { if (playlist && video.currentTime >= playlist.endT) playlistStep(1); }, 120);

    rebuildNames();
    requestAnimationFrame(frame);
  };
})();
