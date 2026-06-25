/* Race to the Moon — dashboard client
   Polls /api/stats, ranks the teams by lines of code, and drives the
   rockets, the count-up readouts and the leader treatment. */

const POLL_MS = 12000;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const els = {
  lanes: document.getElementById('lanes'),
  consoles: document.getElementById('consoles'),
  gridlines: document.getElementById('gridlines'),
  clock: document.getElementById('clock'),
  clockLabel: document.getElementById('clock-label'),
  sync: document.getElementById('sync'),
  liveDot: document.getElementById('live-dot'),
  demoFlag: document.getElementById('demo-flag'),
  offline: document.getElementById('offline'),
  eventSub: document.getElementById('event-sub'),
};

const lanesById = new Map();    // id -> { rocket, alt element refs }
const consolesById = new Map(); // id -> { card + value refs, displayed values }
let lastUpdated = null;
let hackathonStart = null;
let currentLeaderId = null;
let lastMaxLines = -1;

const CROWN_SVG = `<svg class="crown" viewBox="0 0 24 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M2 14 L4 4 L9 9 L12 2 L15 9 L20 4 L22 14 Z" fill="#F6C453" stroke="#B98A2A" stroke-width="0.8" stroke-linejoin="round"/>
  <rect x="2" y="13.5" width="20" height="2.2" rx="1" fill="#E0A937"/>
</svg>`;

const fmt = (n) => Math.round(n).toLocaleString('en-US');

function relTime(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* ---- mission clock + sync timer (tick every second) ---------------------- */
function tickClock() {
  const now = new Date();
  if (hackathonStart) {
    const diff = Math.max(0, (now - new Date(hackathonStart)) / 1000);
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = Math.floor(diff % 60);
    els.clockLabel.textContent = 'Mission elapsed';
    els.clock.textContent = `T+ ${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  } else {
    els.clockLabel.textContent = 'Mission time';
    els.clock.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  }
  if (lastUpdated) {
    els.sync.textContent = `synced ${relTime(lastUpdated)} ago`;
  }
}
setInterval(tickClock, 1000);

/* ---- count-up tween ------------------------------------------------------ */
function animateNumber(el, from, to) {
  if (reduceMotion || from === to) { el.textContent = fmt(to); return; }
  const dur = 850;
  const start = performance.now();
  function step(t) {
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ---- build DOM for a team once ------------------------------------------- */
function buildTeam(team) {
  // lane (rocket in the sky)
  const lane = document.createElement('div');
  lane.className = 'lane';
  lane.style.setProperty('--team', team.color);
  lane.innerHTML = `
    <div class="trail"></div>
    <div class="rocket">
      <div class="ship">
        <div class="nose"></div>
        <div class="body"></div>
        <div class="window"></div>
        <div class="fin left"></div>
        <div class="fin right"></div>
      </div>
      <div class="flame"></div>
    </div>
    <div class="pad"></div>`;
  els.lanes.appendChild(lane);
  lanesById.set(team.id, { lane, rocket: lane.querySelector('.rocket') });

  // console (the ranked readout card)
  const card = document.createElement('div');
  card.className = 'console';
  card.style.setProperty('--team', team.color);
  card.innerHTML = `
    <div class="lead-tag" hidden>Leading the ascent</div>
    <div class="tele-flag" hidden></div>
    <div class="console-main">
      <div class="console-head">
        <span class="rank">—</span>
        <a class="cname" href="${team.repoUrl || '#'}" target="_blank" rel="noopener">${team.name}</a>
        <span class="crown-slot"></span>
      </div>
      <div class="loc">
        <span class="loc-num">0</span>
        <span class="loc-unit">Lines of code</span>
      </div>
      <div class="substats">
        <div class="substat"><span class="s-num s-commits">0</span><span class="s-lab">Commits</span></div>
        <div class="substat"><span class="s-num s-crew">0</span><span class="s-lab">Crew</span></div>
        <div class="substat"><span class="s-num s-push">—</span><span class="s-lab">Last push</span></div>
      </div>
    </div>
    <button class="console-media" type="button" aria-label="View progress screenshots">
      <span class="shot-frame">
        <img class="shot-img" alt="" />
        <span class="shot-empty">Awaiting<br>snapshot</span>
        <span class="shot-overlay"><span class="shot-overlay-text">View history</span></span>
      </span>
      <span class="shot-cap"><span class="shot-cap-label">Latest progress</span><span class="shot-cap-time">—</span></span>
    </button>`;
  els.consoles.appendChild(card);
  consolesById.set(team.id, {
    card,
    rank: card.querySelector('.rank'),
    crownSlot: card.querySelector('.crown-slot'),
    locNum: card.querySelector('.loc-num'),
    commits: card.querySelector('.s-commits'),
    crew: card.querySelector('.s-crew'),
    push: card.querySelector('.s-push'),
    leadTag: card.querySelector('.lead-tag'),
    teleFlag: card.querySelector('.tele-flag'),
    mediaBtn: card.querySelector('.console-media'),
    mediaImg: card.querySelector('.shot-img'),
    mediaCapLabel: card.querySelector('.shot-cap-label'),
    mediaCapTime: card.querySelector('.shot-cap-time'),
    shownLines: 0,
    shownCommits: 0,
    latestShotName: null,
  });
}

/* ---- altitude gridlines (rescale with the leader) ------------------------ */
function renderGridlines(maxLines) {
  if (maxLines === lastMaxLines) return;
  lastMaxLines = maxLines;
  const fracs = [0, 0.25, 0.5, 0.75, 1];
  els.gridlines.innerHTML = fracs.map((f) => {
    const bottom = `calc(var(--pad) + (var(--ceil) - var(--pad)) * ${f})`;
    const label = maxLines > 0 ? fmt(maxLines * f) : (f === 0 ? '0' : '');
    const top = f === 1 ? ' is-top' : '';
    return `<div class="gridline${top}" style="bottom:${bottom}"><span>${label}</span></div>`;
  }).join('');
}

/* ---- main render --------------------------------------------------------- */
function render(snap) {
  if (!snap || !Array.isArray(snap.teams)) return;
  hackathonStart = snap.hackathonStart || null;
  lastUpdated = snap.updatedAt || new Date().toISOString();
  if (snap.event) {
    els.eventSub.textContent = snap.org ? `${snap.event} · ${snap.org}` : snap.event;
  }
  els.demoFlag.hidden = !snap.demo;

  // first paint: build the DOM in config order
  if (lanesById.size === 0) snap.teams.forEach(buildTeam);

  // rank by lines of code (desc)
  const ranked = [...snap.teams].sort((a, b) => (b.lines || 0) - (a.lines || 0));
  const maxLines = Math.max(0, ...ranked.map((t) => t.lines || 0));
  renderGridlines(maxLines);

  const allBroken = snap.teams.length > 0 && snap.teams.every((t) => t.error);
  els.offline.hidden = !(allBroken || snap.error);
  els.liveDot.className = 'live-dot' + (allBroken || snap.error ? ' offline' : (snap.teams.some((t) => t.stale || t.computing) ? ' stale' : ''));

  const leader = ranked[0];
  const leaderChanged = leader && leader.id !== currentLeaderId && (leader.lines || 0) > 0;

  ranked.forEach((team, idx) => {
    const c = consolesById.get(team.id);
    const l = lanesById.get(team.id);
    if (!c || !l) return;

    const isLeader = idx === 0 && (team.lines || 0) > 0;

    // rocket altitude (relative to the leader) — set on the lane so the
    // rocket and its climb trail both read the same --alt.
    const alt = maxLines > 0 ? (team.lines || 0) / maxLines : 0;
    l.lane.style.setProperty('--alt', alt.toFixed(4));
    l.rocket.classList.toggle('leader', isLeader);

    // reorder cards so the board reads 1 · 2 · 3 left→right by rank?
    // No — keep teams in fixed columns so a rocket lines up with its card.
    c.card.style.order = '';

    // rank + crown + leader styling
    c.rank.textContent = (team.lines || 0) > 0 || team.commits > 0 ? `#${idx + 1}` : '—';
    c.card.classList.toggle('is-leader', isLeader);
    c.crownSlot.innerHTML = isLeader ? CROWN_SVG : '';
    c.leadTag.hidden = !isLeader;

    // numbers (animated)
    animateNumber(c.locNum, c.shownLines, team.lines || 0);
    animateNumber(c.commits, c.shownCommits, team.commits || 0);
    c.shownLines = team.lines || 0;
    c.shownCommits = team.commits || 0;
    c.crew.textContent = team.crew || 0;

    // last push / launch state
    if (team.computing) {
      c.push.textContent = 'calibrating';
      c.push.classList.add('pad-state');
    } else if ((team.lines || 0) === 0 && (team.commits || 0) === 0) {
      c.push.textContent = 'on the pad';
      c.push.classList.add('pad-state');
    } else {
      c.push.textContent = relTime(team.lastPush);
      c.push.classList.remove('pad-state');
    }

    // per-card telemetry flag
    if (team.error) {
      c.teleFlag.hidden = false; c.teleFlag.textContent = 'no signal'; c.teleFlag.classList.add('err');
    } else if (team.stale || team.computing) {
      c.teleFlag.hidden = false; c.teleFlag.textContent = team.computing ? 'calibrating' : 'last known'; c.teleFlag.classList.remove('err');
    } else {
      c.teleFlag.hidden = true;
    }

    // progress screenshots
    updateMedia(c, team);
  });

  if (leaderChanged) {
    const c = consolesById.get(leader.id);
    if (c && !reduceMotion) {
      c.card.classList.remove('lead-change');
      void c.card.offsetWidth; // restart animation
      c.card.classList.add('lead-change');
    }
  }
  currentLeaderId = leader ? leader.id : null;
}

/* ---- progress screenshots ------------------------------------------------ */
function shotUrl(teamId, name) {
  return `/api/shot/${encodeURIComponent(teamId)}/${encodeURIComponent(name)}`;
}

function shotTimeLabel(shot, opts = {}) {
  if (shot && shot.time) {
    const d = new Date(shot.time);
    if (!Number.isNaN(d.getTime())) {
      const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      return opts.withDate
        ? `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${hm}`
        : hm;
    }
  }
  return shot ? shot.name.replace(/\.[^.]+$/, '') : '—';
}

function updateMedia(c, team) {
  const shots = team.screenshots || [];
  c.mediaBtn.onclick = () => openShotModal(team);
  if (shots.length) {
    const latest = shots[0];
    if (c.latestShotName !== latest.name) { // only reload when the newest changes
      c.mediaImg.src = shotUrl(team.id, latest.name);
      c.latestShotName = latest.name;
    }
    c.card.classList.add('has-shots');
    c.mediaBtn.disabled = false;
    c.mediaCapLabel.textContent = shots.length > 1 ? `Latest · ${shots.length} snapshots` : 'Latest snapshot';
    c.mediaCapTime.textContent = shotTimeLabel(latest);
  } else {
    c.mediaImg.removeAttribute('src');
    c.latestShotName = null;
    c.card.classList.remove('has-shots');
    c.mediaBtn.disabled = true;
    c.mediaCapLabel.textContent = 'Progress';
    c.mediaCapTime.textContent = 'no snapshots yet';
  }
}

/* ---- screenshot history lightbox ----------------------------------------- */
const modal = {
  root: document.getElementById('shot-modal'),
  team: document.getElementById('shot-modal-team'),
  dot: document.getElementById('shot-modal-dot'),
  sub: document.getElementById('shot-modal-sub'),
  img: document.getElementById('shot-stage-img'),
  cap: document.getElementById('shot-stage-cap'),
  strip: document.getElementById('shot-strip'),
  prev: document.getElementById('shot-prev'),
  next: document.getElementById('shot-next'),
  close: document.getElementById('shot-close'),
};
let modalShots = [];
let modalIndex = 0;
let modalTeamId = null;

function openShotModal(team) {
  const shots = team.screenshots || [];
  if (!shots.length) return;
  modalShots = shots;
  modalTeamId = team.id;
  modal.team.textContent = team.name;
  modal.dot.style.background = team.color;
  modal.root.style.setProperty('--team', team.color);
  modal.sub.textContent = `Progress timeline · ${shots.length} snapshot${shots.length > 1 ? 's' : ''} · newest first`;

  modal.strip.innerHTML = shots.map((s, i) =>
    `<button class="strip-thumb" type="button" data-i="${i}">
       <img loading="lazy" alt="" src="${shotUrl(team.id, s.name)}" />
       <span class="strip-time">${shotTimeLabel(s)}</span>
     </button>`).join('');
  modal.strip.querySelectorAll('.strip-thumb').forEach((el) =>
    el.addEventListener('click', () => selectShot(Number(el.dataset.i))));

  modal.root.hidden = false;
  document.body.classList.add('modal-open');
  selectShot(0);
  modal.close.focus();
}

function selectShot(i) {
  if (i < 0 || i >= modalShots.length) return;
  modalIndex = i;
  const s = modalShots[i];
  modal.img.classList.add('loading');
  modal.img.onload = () => modal.img.classList.remove('loading');
  modal.img.onerror = () => modal.img.classList.remove('loading');
  modal.img.src = shotUrl(modalTeamId, s.name);
  modal.cap.textContent = `${shotTimeLabel(s, { withDate: true })}   ·   ${i + 1} / ${modalShots.length}`;
  modal.prev.disabled = i === 0;
  modal.next.disabled = i === modalShots.length - 1;
  const thumbs = modal.strip.querySelectorAll('.strip-thumb');
  thumbs.forEach((t, ti) => t.classList.toggle('active', ti === i));
  thumbs[i]?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}

function closeShotModal() {
  modal.root.hidden = true;
  document.body.classList.remove('modal-open');
  modal.img.removeAttribute('src');
}

modal.prev.addEventListener('click', () => selectShot(modalIndex - 1));
modal.next.addEventListener('click', () => selectShot(modalIndex + 1));
modal.close.addEventListener('click', closeShotModal);
modal.root.addEventListener('click', (e) => { if (e.target.dataset.close) closeShotModal(); });
document.addEventListener('keydown', (e) => {
  if (modal.root.hidden) return;
  if (e.key === 'Escape') closeShotModal();
  else if (e.key === 'ArrowLeft') selectShot(modalIndex - 1);
  else if (e.key === 'ArrowRight') selectShot(modalIndex + 1);
});

/* ---- polling ------------------------------------------------------------- */
async function poll() {
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    render(await res.json());
  } catch (e) {
    els.offline.hidden = false;
    els.liveDot.className = 'live-dot offline';
    els.sync.textContent = 'reconnecting…';
  }
}
poll();
setInterval(poll, POLL_MS);
tickClock();

/* ---- starfield ----------------------------------------------------------- */
(function starfield() {
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  let w, h, stars;

  function seed() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.width = window.innerWidth * dpr;
    h = canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    const count = Math.round((window.innerWidth * window.innerHeight) / 9000);
    stars = Array.from({ length: count }, (_, i) => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: (Math.random() * 1.1 + 0.3) * dpr,
      base: Math.random() * 0.5 + 0.3,
      amp: Math.random() * 0.4,
      sp: Math.random() * 0.8 + 0.2,
      ph: Math.random() * Math.PI * 2,
    }));
  }
  seed();
  window.addEventListener('resize', seed);

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const tw = reduceMotion ? s.base : s.base + Math.sin(t / 1000 * s.sp + s.ph) * s.amp;
      ctx.globalAlpha = Math.max(0, Math.min(1, tw));
      ctx.fillStyle = s.r > 1.4 ? '#fff3d4' : '#dfe6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduceMotion) requestAnimationFrame(draw);
  }
  if (reduceMotion) draw(0); else requestAnimationFrame(draw);
})();
