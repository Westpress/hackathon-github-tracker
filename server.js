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

// --- config ----------------------------------------------------------------
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (e) {
  console.error('Could not read config.json:', e.message);
  process.exit(1);
}

const PROCESS_START = Date.now();
let latest = null;           // most recent snapshot, served to the browser
const lastGood = new Map();  // teamId -> last successful metrics (carried forward on hiccups)

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

// --- snapshot assembly ------------------------------------------------------
async function buildSnapshot() {
  const teams = [];

  for (let i = 0; i < config.teams.length; i++) {
    const team = config.teams[i];
    const id = team.id || `team${i + 1}`;
    const repoUrl = `https://github.com/${team.owner || config.owner}/${team.repo}`;
    const identity = { id, name: team.name || `Team ${i + 1}`, color: team.color || '#8AB4FF', repoUrl };

    if (DEMO) {
      teams.push({ ...identity, ...demoMetrics(i) });
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
    teams.push({ ...identity, ...m });
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
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  const mode = DEMO
    ? 'DEMO data (no GitHub token set — see .env.example to go live)'
    : 'LIVE GitHub data';
  console.log(`\n  🚀  Race to the Moon is up\n      → http://localhost:${PORT}\n      mode: ${mode}\n      refresh: every ${Math.round(REFRESH_MS / 1000)}s\n`);
});
