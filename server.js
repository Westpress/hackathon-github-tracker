import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 4000);
const TOKEN = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO || '') || !TOKEN;
const REFRESH_MS = Math.max(10000, Number(process.env.REFRESH_MS || 30000));
const SHOTS_DIR = (process.env.SCREENSHOTS_DIR || '').trim(); // overrides config.screenshotsFolder

// --- config ----------------------------------------------------------------
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (e) {
  console.error('Could not read config.json:', e.message);
  process.exit(1);
}

const PROCESS_START = Date.now();
const SCREENSHOTS_DIR = SHOTS_DIR || config.screenshotsFolder || 'screenshots';
let latest = null;            // most recent snapshot, served to the browser
const lastGood = new Map();   // teamId -> last successful metrics (carried forward on hiccups)
const lastShots = new Map();  // teamId -> last successful screenshot list
const shotCache = new Map();  // "teamId/name" -> { buffer, contentType } (images are immutable per name)
const SHOT_CACHE_MAX = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- GitHub plumbing --------------------------------------------------------
async function ghFetch(url, { timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'race-to-the-moon-dashboard',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { /* non-JSON body */ } }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// The /stats/* endpoints return 202 while GitHub crunches the numbers; retry.
async function ghStats(url) {
  for (let i = 0; i < 5; i++) {
    const r = await ghFetch(url);
    if (r.status === 202) { await sleep(1500); continue; }
    return r;
  }
  return { status: 202, json: null };
}

// Fetch raw bytes of a file (used to proxy private screenshots to the browser).
async function ghFetchRaw(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'race-to-the-moon-dashboard',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      // GitHub returned the JSON (base64) representation instead of raw bytes.
      const j = await res.json().catch(() => null);
      if (j && j.content && j.encoding === 'base64') {
        return { status: res.status, buffer: Buffer.from(j.content, 'base64') };
      }
      return { status: res.status, buffer: null };
    }
    const ab = await res.arrayBuffer();
    return { status: res.status, buffer: Buffer.from(ab) };
  } finally {
    clearTimeout(timer);
  }
}

const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
function contentTypeFor(name) {
  return IMG_MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
}

// Pull a timestamp out of a filename like 2026-06-24_14-30.png -> ISO string.
function parseShotTime(name) {
  const m = name.replace(/\.[^.]+$/, '').match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})[T_\- ]?(\d{2})[-:_]?(\d{2})(?:[-:_]?(\d{2}))?/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

// List the screenshots/ folder for a team (newest first).
async function fetchScreenshots(team) {
  const owner = team.owner || config.owner;
  const url = `https://api.github.com/repos/${owner}/${team.repo}/contents/${SCREENSHOTS_DIR}`;
  const r = await ghFetch(url);
  if (r.status === 404) return { ok: true, shots: [] };      // folder not created yet
  if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, shots: [] };
  const shots = r.json
    .filter((f) => f.type === 'file' && IMG_RE.test(f.name))
    .map((f) => ({ name: f.name, sha: f.sha, size: f.size, time: parseShotTime(f.name) }));
  shots.sort((a, b) =>
    a.time && b.time ? b.time.localeCompare(a.time) : b.name.localeCompare(a.name, undefined, { numeric: true })
  );
  return { ok: true, shots };
}

async function fetchTeam(team) {
  const owner = team.owner || config.owner;
  const base = `https://api.github.com/repos/${owner}/${team.repo}`;
  const out = { lines: 0, linesDeleted: 0, commits: 0, crew: 0, lastPush: null, computing: false, error: false, errMsg: '' };

  // Lines added/removed, commit count and contributor ("crew") count all come
  // from the contributor stats endpoint in a single call.
  const c = await ghStats(`${base}/stats/contributors`);
  if (c.status === 202) {
    out.computing = true;            // GitHub is still crunching the stats
  } else if (c.status === 204 || (c.status === 200 && !Array.isArray(c.json))) {
    // 204 No Content = a brand-new, empty repo (no commits yet). Not an error —
    // the team simply hasn't launched. Leave the zeros so the rocket waits on
    // the pad instead of tripping the "telemetry offline" banner.
  } else if (c.status === 200 && Array.isArray(c.json)) {
    out.crew = c.json.length;
    for (const con of c.json) {
      out.commits += con.total || 0;
      for (const w of con.weeks || []) {
        out.lines += w.a || 0;
        out.linesDeleted += w.d || 0;
      }
    }
  } else if (c.status === 404) {
    out.error = true; out.errMsg = 'repo not found / no access';
  } else if (c.status === 401) {
    out.error = true; out.errMsg = 'bad or expired token';
  } else if (c.status === 403 || c.status === 429) {
    out.error = true; out.errMsg = 'rate limited';
  } else {
    out.error = true; out.errMsg = `github http ${c.status}`;
  }

  // Latest commit time = "last push". Always fresh (no stats lag).
  try {
    const lc = await ghFetch(`${base}/commits?per_page=1`);
    if (lc.status === 200 && Array.isArray(lc.json) && lc.json[0]) {
      out.lastPush = lc.json[0].commit?.author?.date || lc.json[0].commit?.committer?.date || null;
    }
  } catch { /* leave lastPush null */ }

  return out;
}

// --- demo data (climbs over time so the board looks alive without a token) --
function demoMetrics(i) {
  const t = (Date.now() - PROCESS_START) / 1000;
  const baseLines = [4200, 2600, 3300][i] ?? 3000;
  const rate = [2.1, 2.9, 1.8][i] ?? 2; // lines/sec — team 2 climbs fastest and can overtake
  const lines = Math.round(baseLines + t * rate + Math.sin(t / 24 + i) * 140);
  const commits = Math.round(lines / (80 + i * 6)) + 9;
  const crew = [4, 3, 4][i] ?? 3;
  const agoSec = ([10, 31, 18][i] ?? 20) + (Math.floor(t) % 42);
  return {
    lines,
    linesDeleted: Math.round(lines * 0.17),
    commits,
    crew,
    lastPush: new Date(Date.now() - agoSec * 1000).toISOString(),
    computing: false,
    error: false,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
function demoScreenshotList(i) {
  const now = Date.now();
  const count = [7, 5, 6][i] ?? 6;
  return Array.from({ length: count }, (_, k) => {
    const d = new Date(now - k * 30 * 60 * 1000);
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
    return { name: `${stamp}.png`, sha: `demo-${i}-${k}`, size: 240000, time: parseShotTime(`${stamp}.png`) };
  });
}

// A generated stand-in "screenshot" for demo mode (no real images available).
function demoImage(teamId, name, color) {
  const t = parseShotTime(name);
  const label = t ? t.replace('T', ' ') : name;
  let h = 2166136261;
  for (const c of name) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = (n) => Math.abs((h >> (n * 4)) % 1000) / 1000;
  const bars = [0, 1, 2, 3, 4].map((n) => 18 + Math.round(rnd(n) * 70));
  const done = 30 + Math.round(rnd(5) * 65);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="monospace">
  <rect width="1280" height="800" fill="#0b1020"/>
  <rect x="0" y="0" width="1280" height="52" fill="#141a30"/>
  <circle cx="32" cy="26" r="7" fill="#ff5f57"/><circle cx="58" cy="26" r="7" fill="#febc2e"/><circle cx="84" cy="26" r="7" fill="#28c840"/>
  <text x="120" y="32" fill="#7b86b0" font-size="20">~/hackathon — ${name}</text>
  <rect x="40" y="92" width="520" height="260" rx="14" fill="#11182e" stroke="${color}" stroke-opacity="0.5"/>
  <text x="64" y="140" fill="#e9ecf7" font-size="30" font-weight="bold">Build progress</text>
  <text x="64" y="250" fill="${color}" font-size="86" font-weight="bold">${done}%</text>
  <rect x="64" y="288" width="472" height="14" rx="7" fill="#23304f"/>
  <rect x="64" y="288" width="${Math.round(4.72 * done)}" height="14" rx="7" fill="${color}"/>
  <rect x="600" y="92" width="640" height="616" rx="14" fill="#0e1428" stroke="#23304f"/>
  ${bars.map((b, n) => `<rect x="${640 + n * 110}" y="${640 - b * 5}" width="64" height="${b * 5}" rx="6" fill="${color}" fill-opacity="${0.45 + n * 0.1}"/>`).join('')}
  <text x="632" y="140" fill="#7b86b0" font-size="22">commits / hour</text>
  <rect x="40" y="392" width="520" height="316" rx="14" fill="#0e1428" stroke="#23304f"/>
  ${[0, 1, 2, 3].map((n) => `<rect x="64" y="${430 + n * 64}" width="${300 + Math.round(rnd(n + 6) * 160)}" height="20" rx="6" fill="#2a3550"/>`).join('')}
  <text x="40" y="780" fill="#5a6390" font-size="22">${label}</text>
</svg>`;
  return { buffer: Buffer.from(svg), contentType: 'image/svg+xml' };
}

// --- snapshot assembly ------------------------------------------------------
async function buildSnapshot() {
  const teams = [];

  for (let i = 0; i < config.teams.length; i++) {
    const team = config.teams[i];
    const id = team.id || `team${i + 1}`;
    const repoUrl = `https://github.com/${team.owner || config.owner}/${team.repo}`;
    const identity = { id, name: team.name || `Team ${i + 1}`, color: team.color || '#8AB4FF', repoUrl };

    if (DEMO) {
      teams.push({ ...identity, ...demoMetrics(i), screenshots: demoScreenshotList(i) });
      continue;
    }

    let m = await fetchTeam(team);
    if ((m.error || m.computing) && lastGood.has(id)) {
      // Carry forward the last good numbers so a transient hiccup or a
      // still-computing stat doesn't drop a rocket back to the launchpad.
      m = { ...lastGood.get(id), computing: m.computing, error: m.error, errMsg: m.errMsg, stale: true };
    } else if (!m.error && !m.computing) {
      lastGood.set(id, { lines: m.lines, linesDeleted: m.linesDeleted, commits: m.commits, crew: m.crew, lastPush: m.lastPush });
    }

    // Screenshots are independent of the commit stats — keep the last good
    // list if a listing call hiccups so the gallery doesn't flicker empty.
    const s = await fetchScreenshots(team);
    let shots = s.shots;
    if (!s.ok && lastShots.has(id)) shots = lastShots.get(id);
    else if (s.ok) lastShots.set(id, shots);

    teams.push({ ...identity, ...m, screenshots: shots });
  }

  return {
    updatedAt: new Date().toISOString(),
    hackathonStart: config.hackathonStart || null,
    event: config.event || 'Hackathon',
    org: config.org || '',
    demo: DEMO,
    teams,
  };
}

let refreshing = false;
async function refresh() {
  if (refreshing) return; // never let a slow GitHub pull stack on top of another
  refreshing = true;
  try {
    latest = await buildSnapshot();
  } catch (e) {
    console.error('refresh failed:', e.message);
    if (!latest) {
      latest = { updatedAt: new Date().toISOString(), demo: DEMO, teams: [], error: e.message };
    }
  } finally {
    refreshing = false;
  }
}

// --- server -----------------------------------------------------------------
await refresh();
setInterval(refresh, REFRESH_MS);

const app = express();
app.get('/api/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(latest || { teams: [] });
});
app.get('/api/health', (_req, res) => res.json({ ok: true, demo: DEMO }));

// Image proxy: streams a private-repo screenshot to the browser using the
// server-side token. Only filenames that appear in a team's listing are
// served, which blocks path traversal and arbitrary fetches.
app.get('/api/shot/:teamId/:name', async (req, res) => {
  const { teamId, name } = req.params;
  if (name.includes('/') || name.includes('..')) return res.status(400).end();

  const idx = config.teams.findIndex((t, i) => (t.id || `team${i + 1}`) === teamId);
  if (idx === -1) return res.status(404).end();

  const known = (latest?.teams?.find((t) => t.id === teamId)?.screenshots || []).some((s) => s.name === name);
  if (!known) return res.status(404).end();

  const key = `${teamId}/${name}`;
  const hit = shotCache.get(key);
  if (hit) {
    res.set('Content-Type', hit.contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    return res.end(hit.buffer);
  }

  try {
    let buffer, contentType;
    if (DEMO) {
      ({ buffer, contentType } = demoImage(teamId, name, config.teams[idx].color || '#8AB4FF'));
    } else {
      const team = config.teams[idx];
      const owner = team.owner || config.owner;
      const url = `https://api.github.com/repos/${owner}/${team.repo}/contents/${SCREENSHOTS_DIR}/${encodeURIComponent(name)}`;
      const r = await ghFetchRaw(url);
      if (r.status !== 200 || !r.buffer) return res.status(502).end();
      buffer = r.buffer;
      contentType = contentTypeFor(name);
    }
    shotCache.set(key, { buffer, contentType });
    if (shotCache.size > SHOT_CACHE_MAX) shotCache.delete(shotCache.keys().next().value);
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.end(buffer);
  } catch (e) {
    res.status(502).end();
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  const mode = DEMO
    ? 'DEMO data (no GitHub token set — see .env.example to go live)'
    : 'LIVE GitHub data';
  console.log(`\n  🚀  Race to the Moon is up\n      → http://localhost:${PORT}\n      mode: ${mode}\n      refresh: every ${Math.round(REFRESH_MS / 1000)}s\n`);
});
