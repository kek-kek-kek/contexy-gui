#!/usr/bin/env node
// contexty server — zero dependencies. `node server.js` serves the dashboard
// and GET /api/rules: a live scan of the agent-context files on this machine
// (Cursor/Claude/Windsurf/Copilot rules, Cursor commands & skills, CLAUDE.md,
// AGENTS.md, ~/.cosmos rules), each with a token estimate and last-touched
// time (git log when available, file mtime otherwise).
//
//   node server.js                 scan ~/Documents + the global dot-dirs
//   node server.js ~/code ~/work   scan these roots instead of ~/Documents
//   PORT=7000 node server.js       serve on another port

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, execFile } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 6161);
const HOME = os.homedir();
// default: every well-known code folder on this machine (Documents alone
// missed ~/Projects/Agency/.cursor/rules/yes-sir.mdc). argv still overrides.
const DEFAULT_WALK = ['Documents', 'Projects', 'Developer', 'code', 'src', 'work', 'dev', 'repos']
  .map((n) => path.join(HOME, n))
  .filter((p) => {
    try { return fs.statSync(p).isDirectory(); }
    catch (err) {
      if (err.code !== 'ENOENT') console.error(`[scan] skip ${p}: ${err.message}`);
      return false;
    }
  });
// argv walk-roots are a CLI feature (`node server.js ~/code`). Electron's
// process.argv is the app binary — never treat that as a scan root.
const WALK_ROOTS = (require.main === module && process.argv.slice(2).length)
  ? process.argv.slice(2).map((p) => path.resolve(p.replace(/^~(?=$|\/)/, HOME)))
  : DEFAULT_WALK;
const MAX_DEPTH = 7; // deep enough for <root>/a/b/c/proj/.cursor/skills/<skill>/SKILL.md
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'worktrees', 'dist', 'build', 'out', 'vendor',
  '.venv', 'venv', '.next', '.Trash', 'Library', 'Pictures', 'Movies', 'Music',
]);
// hidden dirs we DO descend into (everything else dot-prefixed is skipped)
const HIDDEN_ALLOW = new Set(['.cursor', '.claude', '.windsurf', '.github', '.cosmos', '.codeium']);
// inside a .cursor dir, only these subtrees hold context files
const CURSOR_SUBDIRS = new Set(['rules', 'commands', 'skills', 'skills-cursor', 'agents']);

function classify(p) {
  const base = path.basename(p);
  const segs = p.split(path.sep);
  const under = (name) => segs.includes(name);
  if (base === 'CLAUDE.md') return { type: 'rule', source: 'claude' };
  if (base === 'AGENTS.md') return { type: 'rule', source: 'agents' };
  if (base === '.cursorrules') return { type: 'rule', source: 'cursor' };
  if (base === 'copilot-instructions.md') return { type: 'rule', source: 'copilot' };
  if (under('.cosmos') && under('rules')) return { type: 'rule', source: 'cosmos' };
  if (under('.windsurf') || under('.codeium')) return { type: 'rule', source: 'windsurf' };
  if (under('.cursor')) {
    if (under('rules')) return { type: 'rule', source: 'cursor' };
    if (under('commands')) return { type: 'command', source: 'cursor' };
    if (base === 'SKILL.md') return { type: 'skill', source: 'cursor' };
    if (under('agents')) return { type: 'agent', source: 'cursor' };
  }
  return null;
}

// project = the directory that owns the file: parent of the dot-dir for
// nested files, the containing dir for root-level CLAUDE.md/AGENTS.md.
function projectOf(p) {
  const segs = p.split(path.sep);
  for (let i = segs.length - 1; i > 0; i--) {
    if (HIDDEN_ALLOW.has(segs[i])) return segs[i - 1] || null;
  }
  return path.basename(path.dirname(p));
}

function frontmatter(txt) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt);
  if (!m) return {};
  const fm = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(\w+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (/^[>|][+-]?$/.test(val)) {
      // YAML block scalar — fold the indented lines that follow
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      val = parts.join(' ');
    }
    fm[kv[1]] = val;
  }
  return fm;
}

function attachMode(fm) {
  if (fm.alwaysApply === 'true') return 'always';
  if (fm.globs) return `auto (${fm.globs})`;
  if (fm.description) return 'agent-requested';
  return 'manual';
}

function lastTouched(p) {
  // mtime only — a git-log spawn per file was the slowest part of first paint
  // (~2s timeout × N files). Session usage still comes from overlayUsage / vscdb.
  try {
    return fs.statSync(p).mtimeMs;
  } catch (err) {
    console.error(`[scan] stat failed for ${p}`);
    console.error(err.stack);
    return 0;
  }
}

// Distinctive body lines double as usage evidence: a session that embeds the
// FILE'S CONTENT used it even when its path is never named (skills read into
// CLI context, AGENTS.md injected into prompts). Lines are chosen to survive
// JSON-escaped transcripts (ASCII, no quotes/backslashes) and to never match
// skill catalogs (frontmatter + description lines excluded).
function fingerprints(txt, fm) {
  const body = txt.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const desc = fm.description || '';
  const lines = [...new Set(body.split('\n').map((l) => l.trim()))]
    .filter((l) => l.length >= 40 && l.length <= 160)
    .filter((l) => !/["\\]/.test(l) && !/[^\x20-\x7e]/.test(l))
    .filter((l) => !desc.includes(l));
  lines.sort((a, b) => b.length - a.length);
  return lines.slice(0, 2);
}

// One-line description for the tooltip: frontmatter description when present,
// else the first prose line of the body (headings and list markers stripped)
function summaryOf(txt, fm) {
  if (fm.description) return fm.description.slice(0, 200);
  const body = txt.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^#{1,6}\s*/, '').replace(/^[>*-]\s*/, '').replace(/\*\*/g, '');
    if (line.length >= 12) {
      return line.length > 180 ? line.slice(0, 177) + '…' : line;
    }
  }
  return '';
}

function collectFile(p, found) {
  const cls = classify(p);
  if (!cls) return;
  let real;
  try { real = fs.realpathSync(p); } catch (err) { console.error(err.stack); return; }
  if (found.has(real)) return;
  let txt;
  try { txt = fs.readFileSync(real, 'utf8'); } catch (err) { console.error(err.stack); return; }
  const fm = frontmatter(txt);
  // note: path.join(HOME, '.') would normalize the dot away and match everything
  const isGlobal = real.startsWith(HOME + path.sep + '.');
  // skills read better named by their folder: "canvas/SKILL.md"
  const base = path.basename(real);
  const name = cls.type === 'skill' ? `${path.basename(path.dirname(real))}/${base}` : base;
  found.set(real, {
    name,
    path: real,
    type: cls.type,
    source: cls.source,
    scope: isGlobal ? 'global' : 'project',
    project: isGlobal ? null : projectOf(real),
    chars: txt.length,
    tokens: Math.max(1, Math.round(txt.length / 4)),
    lastUsed: lastTouched(real),
    attach: cls.source === 'cursor' && cls.type === 'rule' ? attachMode(fm) : undefined,
    description: fm.description || undefined,
    summary: summaryOf(txt, fm) || undefined,
    fp: fingerprints(txt, fm),
  });
}

function walk(dir, depth, found) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[scan] unreadable dir ${dir}: ${err.message}`);
    return;
  }
  const inCursor = path.basename(dir) === '.cursor';
  const inClaude = path.basename(dir) === '.claude';
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && !HIDDEN_ALLOW.has(e.name)) continue;
      if (inCursor && !CURSOR_SUBDIRS.has(e.name)) continue;
      if (inClaude) continue; // ~/.claude subdirs are transcripts, not rules
      walk(p, depth + 1, found);
    } else if (e.isFile()) {
      if (/\.(md|mdc)$/.test(e.name) || e.name === '.cursorrules') collectFile(p, found);
    }
  }
}

// ---- "last used": scan agent-session transcripts for mentions of each file.
// A rule that shows up in a session transcript was in front of the model; the
// transcript's mtime is when that session last ran. Falls back to git/mtime
// ("edited") when a file never appears in any session.
const USAGE_STORES = [
  path.join(HOME, 'Library', 'Application Support', 'Cosmos', 'claude-config', 'projects'),
  path.join(HOME, '.cursor', 'projects'),
  path.join(HOME, '.claude', 'projects'),
].filter((p) => fs.existsSync(p));

// filenames that exist in many repos — match these by path, not basename
const GENERIC_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'copilot-instructions.md']);
function usagePatterns(r) {
  const base = path.basename(r.path);
  const fp = r.fp || [];
  if (r.type === 'skill') return [r.name.replace(/\.md$/, ''), ...fp]; // "canvas/SKILL" — matches path and .md forms
  if (GENERIC_NAMES.has(base)) {
    const pats = [r.path];
    if (r.project) pats.push(path.join(r.project, base));
    return [...pats, ...fp];
  }
  return [base, ...fp];
}

// ripgrep is ~500x faster than BSD grep on multi-pattern scans of these
// stores; use it when installed, fall back to grep (both zero-install here)
let HAS_RG = false;
try {
  execFileSync('rg', ['--version'], { stdio: 'ignore' });
  HAS_RG = true;
} catch (err) {
  console.error(`[usage] ripgrep not found (${err.message}) — falling back to slower BSD grep`);
}

function search(args, maxBuffer) {
  return new Promise((resolve) => {
    execFile(HAS_RG ? 'rg' : 'grep', args, { maxBuffer, timeout: 20000 }, (err, stdout) => {
      if (err && err.code !== 1) { // exit 1 just means "no matches"
        console.error(`[usage] search ${args[args.length - 1]} failed: ${err.message}`);
        return resolve('');
      }
      resolve(stdout || '');
    });
  });
}

function storeArgs(patsFile, store) {
  return HAS_RG
    ? ['-lF', '--no-ignore', '--no-messages', '-g', '*.{jsonl,json,txt}', '-g', '!**/*contexty*/**', '-f', patsFile, store]
    : ['-rlF', '--include=*.jsonl', '--include=*.json', '--include=*.txt', '--exclude-dir=*contexty*', '-f', patsFile, store];
}

function fileArgs(patsFile, file) {
  const binary = file.endsWith('.db') ? 'a' : '';
  return HAS_RG
    ? [`-o${binary}F`, '--no-ignore', '--no-messages', '--no-filename', '-f', patsFile, file]
    : [`-o${binary}F`, '-f', patsFile, file];
}

// Cursor CLI keeps additional session state in SQLite files under
// ~/.cursor/projects (sdk-agent-store etc.) — searched as binary-as-text
function binaryStoreArgs(patsFile, store) {
  return HAS_RG
    ? ['-laF', '--no-ignore', '--no-messages', '-g', '**/*.db', '-f', patsFile, store]
    : ['-rlaF', '--include=*.db', '-f', patsFile, store];
}

// Two passes so every store is read once, not once per rule:
//   1. one recursive grep per store with ALL patterns -> transcript files that
//      mention anything
//   2. one grep per matched file -> which patterns it mentions
// Cursor's conversation-search.db is an FTS5 index over chat bodies —
// including cloud/Background-Composer sessions that never land in the local
// state.vscdb — with per-conversation updated_at. Skills are queried by
// content fingerprint only (path phrases would match skill catalogs).
const CONV_DB = path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'conversation-search.db');

function ftsPhrases(r) {
  const raw = r.type === 'skill' ? (r.fp || []) : usagePatterns(r);
  return raw
    .map((s) => '"' + String(s).replace(/"/g, ' ').trim() + '"')
    .filter((s) => s.length > 6);
}

function openFtsDb() {
  if (!DatabaseSync || !fs.existsSync(CONV_DB)) return null;
  try {
    return new DatabaseSync(CONV_DB, { readOnly: true });
  } catch (err) {
    console.error(`[fts] open failed: ${err.message}`);
    return null;
  }
}

const OVERLAY_CACHE = path.join(os.tmpdir(), 'contexty-usage-overlay.json');
const OVERLAY_CACHE_V = 1;
let overlayFileCache = { v: OVERLAY_CACHE_V, files: {} }; // path -> { mtime, pats, catalog }

function loadOverlayCache() {
  try {
    const c = JSON.parse(fs.readFileSync(OVERLAY_CACHE, 'utf8'));
    if (c && c.v === OVERLAY_CACHE_V && c.files) overlayFileCache = c;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[usage] overlay cache load failed: ${err.message}`);
  }
}

function saveOverlayCache() {
  try {
    fs.writeFileSync(OVERLAY_CACHE, JSON.stringify(overlayFileCache));
  } catch (err) {
    console.error(`[usage] overlay cache save failed: ${err.message}`);
  }
}

async function overlayUsage(rules) {
  const t0 = Date.now();
  const patIndex = new Map(); // pattern -> rules carrying it
  for (const r of rules) {
    for (const p of usagePatterns(r)) {
      if (!patIndex.has(p)) patIndex.set(p, []);
      patIndex.get(p).push(r);
    }
  }
  const patsFile = path.join(os.tmpdir(), `contexty-patterns-${process.pid}.txt`);
  fs.writeFileSync(patsFile, [...patIndex.keys()].join('\n') + '\n');

  const fileHits = new Set();
  const cliDbStore = path.join(HOME, '.cursor', 'projects');
  await Promise.all([
    ...USAGE_STORES.map(async (store) => {
      // transcripts are .jsonl (Claude/Cosmos) or .json/.txt (Cursor); chats
      // about this dashboard name every rule on the machine, so contexty's own
      // dev chats don't count as usage
      const out = await search(storeArgs(patsFile, store), 16 * 1024 * 1024);
      for (const f of out.split('\n')) if (f) fileHits.add(f);
    }),
    (async () => {
      if (!fs.existsSync(cliDbStore)) return;
      const out = await search(binaryStoreArgs(patsFile, cliDbStore), 16 * 1024 * 1024);
      for (const f of out.split('\n')) if (f) fileHits.add(f);
    })(),
  ]);

  const latest = new Map(); // pattern -> newest transcript mtime mentioning it
  const queue = [...fileHits];
  let grepped = 0;
  let reused = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const f = queue.pop();
      let mtime;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch (statErr) {
        console.error(`[usage] stat failed for ${f}: ${statErr.message}`);
        continue;
      }
      const cached = overlayFileCache.files[f];
      let pats;
      let hasCatalog = false;
      if (cached && cached.mtime === mtime && Array.isArray(cached.pats)) {
        pats = cached.pats;
        hasCatalog = !!cached.catalog;
        reused++;
      } else {
        const out = await search(fileArgs(patsFile, f), 64 * 1024 * 1024);
        if (f.endsWith('.db')) {
          // a session DB embedding the skill catalog mentions every skill path —
          // only content fingerprints count as usage there
          const catArgs = HAS_RG
            ? ['-laF', '--no-ignore', '--no-messages', '-e', '<agent_skill', f]
            : ['-laF', '-e', '<agent_skill', f];
          hasCatalog = (await search(catArgs, 1024 * 1024)).trim().length > 0;
        }
        pats = [...new Set(out.split('\n').filter(Boolean))];
        overlayFileCache.files[f] = { mtime, pats, catalog: hasCatalog };
        grepped++;
      }
      for (const p of pats) {
        if (!patIndex.has(p)) continue;
        if (hasCatalog && /\/SKILL$/.test(p)) continue;
        if (!latest.has(p) || latest.get(p) < mtime) latest.set(p, mtime);
      }
    }
  }));
  try {
    fs.unlinkSync(patsFile);
  } catch (rmErr) {
    console.error(`[usage] could not remove ${patsFile}: ${rmErr.message}`);
  }
  for (const f of Object.keys(overlayFileCache.files)) {
    if (!fileHits.has(f)) delete overlayFileCache.files[f];
  }
  saveOverlayCache();

  const ftsDb = openFtsDb();
  const ftsStmt = ftsDb && ftsDb.prepare(
    'SELECT MAX(c.updated_at) t FROM conversation_fts f JOIN conversations c ON c.fts_rowid = f.rowid WHERE conversation_fts MATCH ?'
  );
  for (const r of rules) {
    const grepAt = Math.max(0, ...usagePatterns(r).map((p) => Math.max(latest.get(p) || 0, vscdbUsage.hits[p] || 0)));
    let ftsAt = 0;
    // skip FTS when grep/vscdb already proved use — those queries were the tail
    if (ftsStmt && grepAt === 0) {
      for (const ph of ftsPhrases(r)) {
        try {
          const row = ftsStmt.get(ph);
          if (row && row.t) ftsAt = Math.max(ftsAt, Number(row.t));
        } catch (qErr) {
          // a body line can tokenize into an invalid FTS query — skip it
          console.error(`[fts] query skipped for ${r.name}: ${qErr.message}`);
        }
      }
    }
    const usedAt = Math.max(ftsAt, grepAt);
    r.editedAt = r.lastUsed;
    if (usedAt > 0) {
      r.usedAt = usedAt;
      r.lastUsed = usedAt;
      r.verb = 'used';
    } else {
      r.usedAt = null;
      r.verb = 'edited';
    }
  }
  if (ftsDb) ftsDb.close();
  console.log(`[usage] overlay ${Date.now() - t0}ms · ${fileHits.size} files · grepped ${grepped} · reused ${reused}`);
}

// ---- Cursor IDE chats: the global state.vscdb holds every in-IDE
// conversation (bubbleId:<composerId>:* message rows, composerHeaders with
// per-conversation timestamps). It's ~4GB, so it's indexed in the background
// in yielding batches with a rowid checkpoint persisted to disk — the first
// pass takes ~30s, every restart after that only reads new rows.
const VSCDB = path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const VSCDB_CACHE = path.join(os.tmpdir(), 'contexty-vscdb-usage.json');
let vscdbUsage = { lastRowid: 0, hits: {} }; // pattern -> newest conversation lastUpdatedAt (ms)
let vscdbState = 'idle'; // idle | scanning | ready | unavailable

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error(`[vscdb] node:sqlite unavailable (${err.message}) — Cursor IDE chat history won't be scanned`);
}

const VSCDB_INDEX_VERSION = 3; // v3: content fingerprints + CLI <agent_skill> catalog exclusion

function loadVscdbCache() {
  try {
    const c = JSON.parse(fs.readFileSync(VSCDB_CACHE, 'utf8'));
    if (c && c.v === VSCDB_INDEX_VERSION && c.dbPath === VSCDB && c.hits) {
      vscdbUsage = { lastRowid: c.lastRowid || 0, hits: c.hits };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[vscdb] cache load failed: ${err.message}`);
  }
}

function saveVscdbCache() {
  try {
    fs.writeFileSync(VSCDB_CACHE, JSON.stringify({ v: VSCDB_INDEX_VERSION, dbPath: VSCDB, lastRowid: vscdbUsage.lastRowid, hits: vscdbUsage.hits }));
  } catch (err) {
    console.error(`[vscdb] cache save failed: ${err.message}`);
  }
}

// Every Cursor session embeds a catalog of ALL installed skills in its context
// report — each as {"kind":"skill","label":".../SKILL.md","categoryId":"skills",
// "estimatedTokens":~35} (name + one-liner only). That is availability, not
// usage. An INVOKED skill loads its whole body, so its context entry carries a
// real token count; mentions outside the catalog (typed /commands, tool reads)
// are usage too.
function isRealUsage(buf, idx, patLen) {
  const ctx = buf.slice(Math.max(0, idx - 160), Math.min(buf.length, idx + patLen + 260)).toString('utf8');
  if (ctx.includes('<agent_skill')) return false; // CLI catalog: <agent_skill fullPath="...">desc</agent_skill>
  if (!ctx.includes('"categoryId":"skills"')) return true;
  const m = /"estimatedTokens":(\d+)/.exec(ctx);
  return m ? Number(m[1]) >= 100 : false;
}

const composerIdOf = (key) => {
  const m = /^(?:bubbleId|composerData|checkpointId):([0-9a-f-]{36})/.exec(key);
  return m ? m[1] : null;
};

async function indexVscdb(allRules) {
  if (!DatabaseSync || !fs.existsSync(VSCDB)) {
    vscdbState = 'unavailable';
    return;
  }
  vscdbState = 'scanning';
  const patIndex = new Map();
  for (const r of allRules) for (const p of usagePatterns(r)) patIndex.set(p, true);
  const pats = [...patIndex.keys()].map((p) => [p, Buffer.from(p)]);
  try {
    const db = new DatabaseSync(VSCDB, { readOnly: true });
    const headerStmt = db.prepare('SELECT lastUpdatedAt, createdAt FROM composerHeaders WHERE composerId = ?');
    const batchStmt = db.prepare('SELECT rowid, key, value FROM cursorDiskKV WHERE rowid > ? ORDER BY rowid LIMIT 2000');
    const t0 = Date.now();
    let rows = 0;
    const composerHits = new Map(); // composerId -> Set(pattern)
    for (;;) {
      const batch = batchStmt.all(vscdbUsage.lastRowid);
      if (!batch.length) break;
      for (const row of batch) {
        vscdbUsage.lastRowid = row.rowid;
        rows++;
        const cid = composerIdOf(row.key);
        if (!cid) continue; // agentKv blobs etc. carry no conversation id
        const buf = typeof row.value === 'string' ? Buffer.from(row.value) : Buffer.from(row.value || []);
        for (const [p, pb] of pats) {
          for (let i = buf.indexOf(pb); i !== -1; i = buf.indexOf(pb, i + 1)) {
            if (isRealUsage(buf, i, pb.length)) {
              if (!composerHits.has(cid)) composerHits.set(cid, new Set());
              composerHits.get(cid).add(p);
              break;
            }
          }
        }
      }
      await new Promise((res) => setImmediate(res)); // keep the server responsive
    }
    for (const [cid, patSet] of composerHits) {
      let h;
      try {
        h = headerStmt.get(cid);
      } catch (hErr) {
        console.error(`[vscdb] header lookup failed for ${cid}: ${hErr.message}`);
        continue;
      }
      const ts = h && (h.lastUpdatedAt || h.createdAt);
      if (!ts) continue;
      for (const p of patSet) {
        if (!vscdbUsage.hits[p] || vscdbUsage.hits[p] < ts) vscdbUsage.hits[p] = ts;
      }
    }
    db.close();
    saveVscdbCache();
    vscdbState = 'ready';
    if (cache.body) {
      try {
        const data = JSON.parse(cache.body);
        applyKnownUsage(data.rules || []);
        cache = { t: Date.now(), body: packScan(data.rules || [], data.roots || scanRoots(), { usageReady: data.usageReady, historySince: data.historySince, scanMs: data.scanMs }) };
        writeScanCache(cache.body);
      } catch (err) {
        console.error(`[vscdb] cache refresh failed: ${err.message}`);
        cache.t = 0;
      }
    }
    console.log(`[vscdb] indexed ${rows} new rows in ${Date.now() - t0}ms; ${Object.keys(vscdbUsage.hits).length} patterns with IDE-chat usage`);
  } catch (err) {
    console.error(err.stack);
    vscdbState = 'unavailable';
  }
}

// ---- /api/models: live pricing from OpenRouter's public model list (no key
// needed), narrowed to a curated 8-model board. Prices and context windows are
// overlaid live; tps/prefill are labeled tier ESTIMATES (OpenRouter's public
// endpoint stats expose no throughput) and the client discloses that.
const OR_MODELS_URL = 'https://openrouter.ai/api/v1/models';
// pinned fallback pricing/context — checked against the live endpoint 2026-08-24
const CURATED_MODELS = [
  { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5', logo: 'claude-logo.png', inPrice: 10, outPrice: 50, context: 1000000, tps: 50, prefill: 7000, aliases: ['claude-fable-5', 'claude-fable-5-thinking-high'] },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', logo: 'claude-logo.png', inPrice: 5, outPrice: 25, context: 1000000, tps: 55, prefill: 8000, aliases: ['claude-opus-5'] },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', logo: 'claude-logo.png', inPrice: 2, outPrice: 10, context: 1000000, tps: 75, prefill: 10000, aliases: ['claude-sonnet-5', 'claude-sonnet-5-thinking-high'] },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', logo: 'claude-logo.png', inPrice: 1, outPrice: 5, context: 200000, tps: 120, prefill: 14000, aliases: ['claude-haiku-4.5', 'claude-4.5-haiku'] },
  { id: 'anthropic/claude-opus-4.8', name: 'Claude Opus 4.8', logo: 'claude-logo.png', inPrice: 5, outPrice: 25, context: 1000000, tps: 55, prefill: 8000, aliases: ['claude-opus-4-8', 'claude-opus-4.8', 'claude-opus-4-8-thinking-high'] },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', logo: 'claude-logo.png', inPrice: 3, outPrice: 15, context: 1000000, tps: 70, prefill: 9000, aliases: ['claude-sonnet-4.6', 'claude-sonnet-4-6'] },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', logo: 'claude-logo.png', inPrice: 3, outPrice: 15, context: 1000000, tps: 70, prefill: 9000, aliases: ['claude-4.5-sonnet', 'claude-sonnet-4-5', 'claude-sonnet-4.5'] },
  { id: 'openai/gpt-5.6-terra', name: 'GPT-5.6 Terra', logo: 'openai-logo.svg', inPrice: 2, outPrice: 12, context: 1050000, tps: 90, prefill: 10000, aliases: ['gpt-5.6-terra', 'gpt-5.6'] },
  { id: 'openai/gpt-5.6-luna', name: 'GPT-5.6 Luna', logo: 'openai-logo.svg', inPrice: 0.2, outPrice: 1.2, context: 1050000, tps: 130, prefill: 14000, aliases: ['gpt-5.6-luna'] },
  { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', logo: 'gemini-logo.svg', inPrice: 2, outPrice: 12, context: 1048576, tps: 90, prefill: 10000, aliases: ['gemini-3.1-pro', 'gemini-3-pro'] },
  { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash', logo: 'gemini-logo.svg', inPrice: 0.375, outPrice: 1.875, context: 1048576, tps: 150, prefill: 16000, aliases: ['gemini-3.7-flash', 'gemini-flash'] },
  { id: 'x-ai/grok-4.6', name: 'Grok 4.6', logo: 'x-ai-logo.png', inPrice: 2, outPrice: 6, context: 500000, tps: 95, prefill: 12000, aliases: ['grok-4.6'] },
  { id: 'x-ai/grok-4.5', name: 'Grok 4.5', logo: 'x-ai-logo.png', inPrice: 2, outPrice: 6, context: 500000, tps: 95, prefill: 12000, aliases: ['grok-4.5', 'cursor-grok-4.5-high-fast'] },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', logo: 'deepseek-logo.png', inPrice: 0.79, outPrice: 1.581, context: 1048576, tps: 90, prefill: 12000, aliases: ['deepseek-v4-pro', 'deepseek-v4', 'deepseek'] },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', logo: 'deepseek-logo.png', inPrice: 0.089, outPrice: 0.177, context: 1048576, tps: 140, prefill: 16000, aliases: ['deepseek-v4-flash'] },
  { id: 'cursor/composer-2.5-fast', name: 'Composer 2.5 Fast', logo: 'cursor-logo.png', inPrice: 1.2, outPrice: 6, context: 200000, tps: 140, prefill: 16000, aliases: ['composer-2.5-fast', 'composer-2.5', 'composer-1'] },
];

const IDE_KEYS = [
  { name: 'Cursor', key: 'cursor' },
  { name: 'Claude Code', key: 'claude' },
  { name: 'Windsurf', key: 'windsurf' },
  { name: 'GitHub Copilot', key: 'copilot' },
  { name: 'Zed', key: 'zed' },
];

function collectToolUsage() {
  const models = {};
  const ides = { cursor: 0, claude: 0, windsurf: 0, copilot: 0, zed: 0 };
  if (DatabaseSync && fs.existsSync(VSCDB)) {
    try {
      const db = new DatabaseSync(VSCDB, { readOnly: true });
      ides.cursor = db.prepare('SELECT COUNT(*) n FROM composerHeaders').get().n || 0;
      const rows = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
      for (const row of rows) {
        const raw = row.value;
        const s = typeof raw === 'string' ? raw : Buffer.from(raw || []).toString('utf8');
        let j;
        try { j = JSON.parse(s); } catch (err) { continue; }
        const names = [];
        const walk = (o, depth) => {
          if (!o || depth > 6) return;
          if (Array.isArray(o)) { for (const x of o.slice(0, 16)) walk(x, depth + 1); return; }
          if (typeof o !== 'object') return;
          if (typeof o.modelName === 'string') { names.push(o.modelName); return; }
          if (typeof o.modelId === 'string') { names.push(o.modelId); return; }
          for (const v of Object.values(o)) walk(v, depth + 1);
        };
        walk(j, 0);
        for (const n of names) models[n] = (models[n] || 0) + 1;
      }
      db.close();
    } catch (err) {
      console.error(`[usage] cursor model tally failed: ${err.message}`);
    }
  }
  const claudeDir = path.join(HOME, '.claude', 'projects');
  if (fs.existsSync(claudeDir)) {
    const walkDir = (dir, depth) => {
      if (depth > 6) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (err) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jsonl')) {
          ides.claude += 1;
          let txt = '';
          try { txt = fs.readFileSync(p, 'utf8'); } catch (err) { continue; }
          for (const line of txt.split('\n')) {
            if (!line.includes('"model"')) continue;
            try {
              const j = JSON.parse(line);
              const m = j.model || (j.message && j.message.model);
              if (m && m !== '<synthetic>') models[m] = (models[m] || 0) + 1;
            } catch (err) { /* skip */ }
          }
        }
      }
    };
    walkDir(claudeDir, 0);
  }
  if (fs.existsSync(path.join(HOME, '.codeium', 'windsurf'))) ides.windsurf += 1;
  if (fs.existsSync(path.join(HOME, '.github'))) ides.copilot += 1;
  if (fs.existsSync(path.join(HOME, '.zed'))) ides.zed += 1;
  return { models, ides };
}

function modelUses(row, usage) {
  let n = usage.models[row.id] || 0;
  for (const a of row.aliases || []) n += usage.models[a] || 0;
  return n;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'contexty' }, timeout: 12000 }, (r) => {
      if (r.statusCode !== 200) {
        r.resume();
        return reject(new Error(`HTTP ${r.statusCode}`));
      }
      let raw = '';
      r.on('data', (c) => { raw += c; });
      r.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
      });
    }).on('timeout', function () { this.destroy(new Error('timeout')); })
      .on('error', reject);
  });
}

const TOOL_USAGE_CACHE = path.join(os.tmpdir(), 'contexty-tool-usage.json');
let toolUsageMem = null;

function emptyToolUsage() { return { models: {}, ides: { cursor: 0, claude: 0, windsurf: 0, copilot: 0, zed: 0 } }; }

function loadToolUsage() {
  if (toolUsageMem) return toolUsageMem.data;
  try {
    const c = JSON.parse(fs.readFileSync(TOOL_USAGE_CACHE, 'utf8'));
    if (c && c.models && c.ides) {
      toolUsageMem = { t: c.t || Date.now(), data: { models: c.models, ides: c.ides } };
      return toolUsageMem.data;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[usage] tool-usage cache load failed: ${err.message}`);
  }
  toolUsageMem = { t: 0, data: emptyToolUsage() };
  return toolUsageMem.data;
}

let toolUsageRefreshing = null;
function refreshToolUsage() {
  if (toolUsageRefreshing) return toolUsageRefreshing;
  toolUsageRefreshing = Promise.resolve().then(() => {
    const data = collectToolUsage();
    toolUsageMem = { t: Date.now(), data };
    try { fs.writeFileSync(TOOL_USAGE_CACHE, JSON.stringify({ t: toolUsageMem.t, ...data })); }
    catch (err) { console.error(`[usage] tool-usage cache save failed: ${err.message}`); }
    modelsCache.t = 0; // next /api/models re-sorts with fresh counts
    console.log(`[usage] tool tally ${Object.keys(data.models).length} model names · cursor chats ${data.ides.cursor}`);
  }).catch((err) => {
    console.error(err.stack);
  }).finally(() => { toolUsageRefreshing = null; });
  return toolUsageRefreshing;
}

let modelsCache = { t: 0, ttl: 0, body: null };
async function models() {
  if (modelsCache.body && Date.now() - modelsCache.t < modelsCache.ttl) return modelsCache.body;
  let live = false;
  const usage = loadToolUsage();
  const out = CURATED_MODELS.map((m, i) => {
    const { aliases, ...rest } = m;
    return { ...rest, uses: modelUses(m, usage), _i: i };
  });
  out.sort((a, b) => (b.uses - a.uses) || (a._i - b._i));
  for (const m of out) delete m._i;
  const ides = IDE_KEYS.map((i, idx) => ({ name: i.name, uses: usage.ides[i.key] || 0, _i: idx }));
  ides.sort((a, b) => (b.uses - a.uses) || (a._i - b._i));
  for (const i of ides) delete i._i;
  try {
    const data = await fetchJson(OR_MODELS_URL);
    const byId = new Map((data.data || []).map((m) => [m.id, m]));
    for (const m of out) {
      const row = byId.get(m.id);
      if (!row || !row.pricing) continue;
      // ×1e6 leaves float noise ($0.19999…) — round to a tenth of a cent/MTok
      m.inPrice = Math.round(Number(row.pricing.prompt) * 1e6 * 1000) / 1000;
      m.outPrice = Math.round(Number(row.pricing.completion) * 1e6 * 1000) / 1000;
      if (row.context_length) m.context = row.context_length;
      live = true;
    }
  } catch (err) {
    console.error(`[models] OpenRouter fetch failed (${err.message}) — serving pinned fallback prices`);
  }
  modelsCache = {
    t: Date.now(),
    ttl: live ? 3600000 : 300000, // retry sooner after a failed fetch
    body: JSON.stringify({ live, fetchedAt: Date.now(), models: out, ides }),
  };
  return modelsCache.body;
}

// ---- /api/trash: move a scanned context file to ~/.Trash. Two-step consent:
// the first POST only answers {needsConfirm:true}; only ?confirm=1 (sent by
// the in-app confirm card) actually moves the file. The path must be a file
// the current scan produced — nothing outside those roots can be touched.
let scannedPaths = new Set();

function trashFile(body, confirmed, res) {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const p = String(body.path || '');
  let real;
  try {
    real = fs.realpathSync(p);
  } catch (err) {
    console.error(`[trash] no such file ${p}: ${err.message}`);
    return json(404, { error: 'no such file' });
  }
  if (!scannedPaths.has(real)) return json(403, { error: 'not a scanned context file' });
  const name = path.basename(real);
  if (!confirmed) return json(200, { needsConfirm: true, path: real, name });
  const trashDir = path.join(HOME, '.Trash');
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let dest = path.join(trashDir, name);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(trashDir, `${stem} ${i}${ext}`);
  try {
    fs.renameSync(real, dest);
  } catch (err) {
    console.error(err.stack);
    return json(500, { error: 'move failed' });
  }
  scannedPaths.delete(real);
  cache.t = 0; // next /api/rules rescans without the trashed file
  console.log(`[trash] ${real} → ${dest}`);
  return json(200, { ok: true, trashedTo: dest });
}

const SCAN_CACHE = path.join(os.tmpdir(), 'contexty-scan.json');
let cache = { t: 0, body: null };
let scanning = null; // coalesces concurrent file-walks
let overlaying = null;
let overlayPending = null;
let scanGen = 0; // drop overlay writes that lost a race with a newer walk

function scheduleOverlay(rules, roots, gen) {
  overlayPending = { rules, roots, gen: gen == null ? scanGen : gen };
  if (overlaying) return overlaying;
  overlaying = (async () => {
    while (overlayPending) {
      const job = overlayPending;
      overlayPending = null;
      try {
        await overlayUsage(job.rules);
        if (job.gen !== scanGen) continue;
        cache = { t: Date.now(), body: packScan(job.rules, job.roots, { usageReady: true, historySince: historyFloor() }) };
        writeScanCache(cache.body);
        console.log(`[scan] usage overlay ready (${job.rules.length} files)`);
      } catch (err) {
        console.error(err.stack);
      }
    }
  })().finally(() => { overlaying = null; });
  return overlaying;
}

function scanRoots() {
  return [
    ...WALK_ROOTS,
    path.join(HOME, '.cursor'),
    path.join(HOME, '.claude'),
    path.join(HOME, '.cosmos', 'rules'),
    path.join(HOME, '.codeium', 'windsurf'),
  ].filter((p) => {
    try { return fs.statSync(p).isDirectory(); }
    catch (err) {
      if (err.code !== 'ENOENT') console.error(`[scan] skip ${p}: ${err.message}`);
      return false;
    }
  });
}

function collectRules() {
  const found = new Map();
  const roots = scanRoots();
  for (const r of roots) walk(r, 0, found);
  return { roots, rules: [...found.values()].sort((a, b) => b.tokens - a.tokens) };
}

function applyKnownUsage(rules) {
  // instant "used" labels from vscdb + the last overlay (no grep on first paint)
  const prev = new Map();
  if (cache.body) {
    try {
      for (const r of JSON.parse(cache.body).rules || []) {
        if (r.path) prev.set(r.path, r);
      }
    } catch (err) {
      console.error(`[scan] previous-usage merge failed: ${err.message}`);
    }
  }
  for (const r of rules) {
    r.editedAt = r.lastUsed;
    const old = prev.get(r.path);
    const usedAt = Math.max(
      (old && old.usedAt) || 0,
      ...usagePatterns(r).map((p) => vscdbUsage.hits[p] || 0)
    );
    if (usedAt > 0) {
      r.usedAt = usedAt;
      r.lastUsed = usedAt;
      r.verb = 'used';
    } else {
      r.usedAt = null;
      r.verb = 'edited';
    }
  }
}

function historyFloor() {
  const fdb = openFtsDb();
  if (!fdb) return null;
  try {
    const row = fdb.prepare('SELECT MIN(updated_at) t FROM conversations').get();
    return row && row.t ? Number(row.t) : null;
  } catch (hErr) {
    console.error(`[fts] history floor query failed: ${hErr.message}`);
    return null;
  } finally {
    fdb.close();
  }
}

function packScan(rules, roots, extra) {
  return JSON.stringify({
    generatedAt: Date.now(),
    scanMs: extra.scanMs || 0,
    roots,
    usageStores: USAGE_STORES,
    vscdb: vscdbState,
    historySince: extra.historySince || null,
    usageReady: !!extra.usageReady,
    count: rules.length,
    rules,
  });
}

function writeScanCache(body) {
  try {
    const j = JSON.parse(body);
    if (!j.usageReady) {
      try {
        const old = JSON.parse(fs.readFileSync(SCAN_CACHE, 'utf8'));
        if (old && old.usageReady) return; // keep the last complete overlay for next launch
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[scan] cache peek failed: ${err.message}`);
      }
    }
    fs.writeFileSync(SCAN_CACHE, body);
  } catch (err) {
    console.error(`[scan] cache save failed: ${err.message}`);
  }
}

function loadScanCache() {
  try {
    const raw = fs.readFileSync(SCAN_CACHE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.rules) || !j.rules.length) return;
    if (Date.now() - (j.generatedAt || 0) > 6 * 3600 * 1000) return;
    cache = { t: Date.now(), body: raw };
    scannedPaths = new Set(j.rules.map((r) => r.path).filter(Boolean));
    console.log(`[scan] restored ${j.rules.length} files from disk cache`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[scan] cache load failed: ${err.message}`);
  }
}

async function scan(opts = {}) {
  // a page reload passes ?fresh=1 so a newly-added rule (yes-sir.mdc) shows up
  // immediately instead of waiting out the 60s cache
  if (!opts.fresh && cache.body && Date.now() - cache.t < 60000) return cache.body;
  if (scanning) return scanning;
  scanning = (async () => {
    try {
      const t0 = Date.now();
      const gen = ++scanGen;
      const { roots, rules } = collectRules();
      scannedPaths = new Set(rules.map((r) => r.path)); // the /api/trash allowlist
      applyKnownUsage(rules);
      let prevReady = false;
      let prevSince = null;
      if (cache.body) {
        try {
          const prev = JSON.parse(cache.body);
          prevReady = !!prev.usageReady;
          prevSince = prev.historySince || null;
        } catch (err) {
          console.error(`[scan] prev cache parse failed: ${err.message}`);
        }
      }
      cache = {
        t: Date.now(),
        body: packScan(rules, roots, { scanMs: Date.now() - t0, historySince: prevSince, usageReady: prevReady }),
      };
      writeScanCache(cache.body);
      console.log(`[scan] ${rules.length} context files in ${Date.now() - t0}ms (usage in background)`);
      scheduleOverlay(rules, roots, gen);
      return cache.body;
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
};

function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/rules') {
      const fresh = url.searchParams.get('fresh') === '1';
      const send = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(body);
      };
      // paint from cache immediately; a walk still runs in the background when
      // the client asked for a fresh disk scan
      if (cache.body) {
        send(cache.body);
        if (fresh || Date.now() - cache.t >= 60000) scan({ fresh: true }).catch((err) => console.error(err.stack));
        return;
      }
      scan({ fresh })
        .then(send)
        .catch((err) => {
          console.error(err.stack);
          res.writeHead(500).end('scan failed');
        });
      return;
    }
    if (url.pathname === '/api/models') {
      models()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(body);
        })
        .catch((err) => {
          console.error(err.stack);
          res.writeHead(500).end('models failed');
        });
      return;
    }
    if (url.pathname === '/api/trash') {
      if (req.method !== 'POST') {
        res.writeHead(405).end('POST only');
        return;
      }
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 10000) req.destroy();
      });
      req.on('end', () => {
        // the allowlist comes from the last scan — make sure one has run
        scan()
          .then(() => trashFile(JSON.parse(raw || '{}'), url.searchParams.get('confirm') === '1', res))
          .catch((err) => {
            console.error(err.stack);
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'bad request' }));
          });
      });
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  } catch (err) {
    console.error(err.stack);
    res.writeHead(500).end('server error');
  }
}

function kickoffIndexer() {
  refreshToolUsage();
  const start = cache.body ? Promise.resolve(cache.body) : scan();
  start
    .then((body) => {
      const data = JSON.parse(body);
      // overlay is incremental (per-file mtime cache) — always refresh so new
      // sessions show up without blocking first paint
      scheduleOverlay(data.rules || [], data.roots || scanRoots());
      return indexVscdb(data.rules || []);
    })
    .catch((err) => console.error(err.stack));
}

function startServer(port = PORT) {
  loadVscdbCache();
  loadOverlayCache();
  loadScanCache();
  const server = http.createServer(handleRequest);
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.close();
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const addr = server.address();
      console.log(`contexty → http://127.0.0.1:${addr.port}/  (scanning: ${WALK_ROOTS.join(', ')} + global dot-dirs)`);
      resolve({ server, port: addr.port });
      setImmediate(() => kickoffIndexer());
    });
  });
}

if (require.main === module) {
  startServer(PORT).catch((err) => {
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { startServer };
