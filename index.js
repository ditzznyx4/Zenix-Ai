'use strict';
/* ============================================================
   ZENIX AI — BACKEND (index.js)
   Zero-dependency Node handler untuk Vercel (@vercel/node).
   Env wajib : OPENROUTER_API_KEY
   Env opsional:
     AUTH_SECRET                      secret penandatangan token (default: turunan dari OPENROUTER_API_KEY)
     UPSTASH_REDIS_REST_URL / _TOKEN  database akun lintas-perangkat (juga KV_REST_API_URL / _TOKEN)
     ZENIX_MODEL_<NAMA>               override model OpenRouter, mis. ZENIX_MODEL_FLUX_5_5=nvidia/nemotron-3-ultra-550b-a55b
     SKILL_BUDGET                     batas karakter skill yang disuntik per request (default 70000)
     ZENIX_REBRAND=0                  matikan penggantian kata "Claude" -> "Zenix" di prompt
     ENABLE_SCRIPTS=0                 matikan eksekusi script node
   ============================================================ */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
function loadBundle() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'zenix-data.json'), 'utf8')); } catch (e) { /* pakai folder */ }
  const out = {};
  (function walk(dir, rel) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    ents.forEach((en) => {
      const p = path.join(dir, en.name), r = rel ? rel + '/' + en.name : en.name;
      if (en.isDirectory()) walk(p, r);
      else { try { out[r] = fs.readFileSync(p, 'utf8'); } catch (e) { /* skip */ } }
    });
  })(path.join(ROOT, 'zenix'), '');
  return out;
}
const BUNDLE = loadBundle();
const ZDIR = '/tmp/zenix-scripts';
const PUB = fs.existsSync(path.join(ROOT, 'chat.html')) ? ROOT : path.join(ROOT, 'public');
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const WORK = '/tmp/zenix-work';

/* ============================================================
   PETA MODEL: nama Zenix -> slug OpenRouter (100% FREE, berakhiran :free)
   Daftar free OpenRouter bisa berubah. Kalau ada yang mati, ganti di sini
   atau lewat env Vercel tanpa edit kode:
     ZENIX_MODEL_LUMEN_4_5, ZENIX_MODEL_SOLIS_4_8, ZENIX_MODEL_SOLIS_5, ZENIX_MODEL_FLUX_5_5
   ============================================================ */
const MODEL_MAP = {
  'lumen-4.5': 'nvidia/nemotron-3.5-lightning:free',     // paling cepat, konteks 1M
  'solis-4.8': 'google/gemma-4-26b-a4b-it:free',         // cepat & seimbang, konteks 262K
  'solis-5':   'qwen/qwen3.8-27b:free',                  // fleksibel, kualitas tertinggi di daftar free, konteks 262K
  'flux-5.5':  'nvidia/nemotron-3-ultra-550b-a55b:free'  // terbesar, konteks 1M
};
// Cadangan (tetap FREE) dipakai HANYA kalau model utama kena limit/mati. Env: ZENIX_BACKUP_<NAMA>="a:free,b:free"
const BACKUP_MAP = {
  'lumen-4.5': ['google/gemma-4-26b-a4b-it:free', 'openrouter/free'],
  'solis-4.8': ['nvidia/nemotron-3.5-lightning:free', 'openrouter/free'],
  'solis-5':   ['nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter/free'],
  'flux-5.5':  ['qwen/qwen3.8-27b:free', 'openrouter/free']
};

/* ---------------- MODEL REGISTRY ----------------
   Urutan naik: Lumen 4.5 < Solis 4.8 < Solis 5 < Flux 5.5
   Speed   : Lumen 4.5, Solis 4.8  -> model kecil/menengah, output pendek, timeout ketat
   Flexible: Solis 5, Flux 5.5     -> model besar konteks 1M, output panjang, effort penuh
   */
const CTX = {
  'nvidia/nemotron-3.5-lightning:free': 1000000,
  'google/gemma-4-26b-a4b-it:free': 262144,
  'qwen/qwen3.8-27b:free': 262144,
  'nvidia/nemotron-3-ultra-550b-a55b:free': 1000000,
  'openrouter/free': 200000
};
const EFFORTS = ['rendah', 'sedang', 'tinggi', 'ekstra', 'maks'];
const OR_EFFORT = { rendah: 'low', sedang: 'medium', tinggi: 'high', ekstra: 'high', maks: 'high' };
const EFFORT_MULT = { rendah: 0.5, sedang: 1, tinggi: 1, ekstra: 1.5, maks: 2 };
const EFFORT_HINT = {
  rendah: 'Answer directly and briefly.',
  sedang: '',
  tinggi: 'Reason carefully before answering and check edge cases.',
  ekstra: 'Reason step by step thoroughly and verify your answer before finalizing.',
  maks: 'Maximum rigor: decompose the problem, weigh alternatives, and double-check every claim, number and code path before finalizing.'
};

const MODELS = {
  'lumen-4.5': {
    label: 'Lumen 4.5', tagline: 'Tercepat untuk jawaban singkat', profile: 'speed',
    core: 'zenix-lumen-4.5.md', code: 'zenix-code/zenix-code-lumen-4.5.md',
    maxTokens: 3072, hardMax: 6144, maxEffort: 'sedang', temp: 0.5, timeoutMs: 22000,
    style: 'Prioritize speed: be concise and get to the answer immediately unless the user asks for depth.'
  },
  'solis-4.8': {
    label: 'Solis 4.8', tagline: 'Paling seimbang untuk tugas sehari-hari', profile: 'speed',
    core: 'zenix-solis-4.8.md', code: 'zenix-code/zenix-code-solis-4.8.md',
    maxTokens: 6144, hardMax: 12288, maxEffort: 'tinggi', temp: 0.6, timeoutMs: 30000,
    style: 'Prioritize speed with solid quality: be efficient, structured and accurate.'
  },
  'solis-5': {
    label: 'Solis 5', tagline: 'Lebih tajam untuk pekerjaan yang lebih rumit', profile: 'flexible',
    core: 'zenix-solis-5.md', code: 'zenix-code/zenix-code-solis-5.md',
    maxTokens: 12288, hardMax: 24576, maxEffort: 'ekstra', temp: 0.7, timeoutMs: 45000,
    style: 'Prioritize flexibility and depth: adapt to any task shape, handle multi-step and ambiguous problems, and be complete.'
  },
  'flux-5.5': {
    label: 'Flux 5.5', tagline: 'Paling fleksibel untuk tantangan terbesar', profile: 'flexible',
    core: 'zenix-flux-5.5.md', code: 'zenix-code/zenix-code-flux-5.5.md',
    maxTokens: 16384, hardMax: 32768, maxEffort: 'maks', temp: 0.7, timeoutMs: 50000,
    style: 'Prioritize maximum flexibility, depth and correctness: take on the hardest tasks, plan before acting, and verify results.'
  }
};
const DEFAULT_MODEL = 'solis-4.8';

const MODE_FILE = {
  code: (cfg) => cfg.code,
  design: () => 'zenix-design/zenix-design.md',
  cowork: () => 'zenix-cowork/zenix-cowork.md'
};

function chainFor(id) {
  const key = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const primary = (process.env['ZENIX_MODEL_' + key] || MODEL_MAP[id]).trim();
  const extra = process.env['ZENIX_BACKUP_' + key];
  const backups = extra ? extra.split(',').map((x) => x.trim()).filter(Boolean) : BACKUP_MAP[id] || [];
  return [primary].concat(backups).filter((m, i, arr) => arr.indexOf(m) === i).map((m) => ({ id: m, ctx: CTX[m] || 131000 }));
}

/* ---------------- FILE / PROMPT LOADER ---------------- */
const cache = new Map();
function readRaw(rel) {
  if (BUNDLE[rel] === undefined) throw new Error('File tidak ada: ' + rel);
  return BUNDLE[rel];
}
function rebrand(t) {
  if (process.env.ZENIX_REBRAND === '0') return t;
  return t.replace(/\bClaude\b/g, 'Zenix').replace(/\bAnthropic\b/g, 'Antheric');
}
function stripFront(t) { return t.replace(/^---\n[\s\S]*?\n---\n?/, ''); }
function promptText(rel) {
  const k = 'P:' + rel;
  if (!cache.has(k)) cache.set(k, rebrand(readRaw(rel)));
  return cache.get(k);
}


/* ---------------- PEMANGKAS PROMPT ----------------
   File prompt asli penuh dengan skema tool/function-calling, contoh, dan sistem memory yang TIDAK
   bisa dipakai di web chat ini (tidak ada tool). Isinya ratusan ribu token dan itulah yang membuat
   model free cepat kena limit. Yang dibuang HANYA plumbing tool; seluruh aturan perilaku, identitas,
   keselamatan, gaya bahasa, thinking, dan skill tetap utuh.
   ZENIX_PROMPT=full -> kirim prompt apa adanya tanpa dipangkas. */
const DROP_TAGS = /^(examples?|example_group|rationale|good_response|bad_response|[a-z_]*_examples?|good_[a-z_]+|bad_[a-z_]+|[a-z_]*memory[a-z_]*|persistent_storage_for_artifacts|mcp_app_suggestions|past_chats_tools|end_conversation_tool_info|an[a-z]+_api_in_artifacts|using_image_search_tool|search_instructions|citation_instructions|computer_use|publishing_artifacts|request_evaluation_checklist|when_to_use_visualizer_for_inline_visuals|lean_build_defaults|output_budget|artifact_usage_criteria|artifacts_info|preferences_info|preferences|preferences_guardrails|important_safety_reminders|privacy_requirements|protected_attributes|sensitive_information|never_store|omission_guidance|behavioral_guardrails|file_handling_rules|producing_outputs|sharing_files|package_management|high_level_computer_use_explanation|file_creation_advice|additional_skills_reminder|skills|network_configuration|filesystem_configuration|available_skills)$/i;
const DROP_H1 = /memory|privacy|preferences|filesystem|artifact|sensitive|never_store|protected_attributes|omission|behavioral_guardrails|important_safety|connector|search|tool|skills?$|network|visualizer|computer_use|citation|lean_build|output_budget|request_evaluation|storage|browser storage|content safety/i;
const KEEP_TAIL = /^(conversational_register|thinking_behavior|proactivity|tone_preference|[a-z_]*behavior|[a-z_]*register)$/i;

function stripSchemas(t) {
  const L = t.split('\n'), o = [];
  for (let i = 0; i < L.length; i++) {
    if (/^\s*```json\s*$/.test(L[i])) {
      let j = i + 1;
      while (j < L.length && !/^\s*```\s*$/.test(L[j])) j++;
      const blk = L.slice(i, j + 1).join('\n');
      if (j < L.length && /"parameters"|"input_schema"|"properties"/.test(blk)) { i = j; continue; }
    }
    o.push(L[i]);
  }
  return o.join('\n');
}
function dropTagBlocks(t) {
  const L = t.split('\n'), o = [];
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(/^\s*`?<([a-zA-Z_]+)(?:\s[^>]*)?>`?\s*$/);
    if (m && DROP_TAGS.test(m[1])) {
      const n = m[1], ro = new RegExp('^\\s*`?<' + n + '(?:\\s[^>]*)?>`?\\s*$'), rc = new RegExp('^\\s*`?</' + n + '>`?\\s*$');
      let d = 1, j = i + 1;
      while (j < L.length && d > 0) { if (ro.test(L[j])) d++; else if (rc.test(L[j])) d--; j++; }
      i = (d === 0 ? j : L.length) - 1; // tag tak tertutup (mis. available_skills) -> buang sampai akhir
      continue;
    }
    o.push(L[i]);
  }
  return o.join('\n');
}
function dropHeadings(t) {
  const o = []; let skip = false;
  t.split('\n').forEach((l) => {
    const m = l.match(/^#\s+(.+?)\s*$/);
    if (m) skip = DROP_H1.test(m[1]);
    if (!skip) o.push(l);
  });
  return o.join('\n');
}
function keepTailBlocks(tail) {
  const L = tail.split('\n'), o = [];
  for (let i = 0; i < L.length; i++) {
    const m = L[i].match(/^\s*`?<([a-zA-Z_]+)>`?\s*$/);
    if (m && KEEP_TAIL.test(m[1])) {
      const n = m[1], rc = new RegExp('^\\s*`?</' + n + '>`?\\s*$');
      let j = i;
      while (j < L.length && !rc.test(L[j])) j++;
      o.push(L.slice(i, Math.min(j + 1, L.length)).join('\n'));
      i = j;
    }
  }
  return o.join('\n\n');
}
function compactPrompt(t) {
  let x = dropHeadings(dropTagBlocks(stripSchemas(t)));
  const m = x.match(/<\/claude_behavior>`?/);
  if (m) {
    const end = m.index + m[0].length;
    x = x.slice(0, end) + '\n\n' + keepTailBlocks(x.slice(end));
  }
  return x.replace(/\n{3,}/g, '\n\n');
}
function capAtBoundary(t, n) {
  if (t.length <= n) return t;
  let cut = Math.max(t.lastIndexOf('\n## ', n), t.lastIndexOf('\n# ', n), t.lastIndexOf('\n\n', n));
  if (cut < n * 0.6) cut = n;
  return t.slice(0, cut) + '\n[...bagian tool dipangkas...]';
}
function corePrompt(rel) {
  const k = 'C:' + rel;
  if (!cache.has(k)) cache.set(k, rebrand(process.env.ZENIX_PROMPT === 'full' ? readRaw(rel) : compactPrompt(readRaw(rel))));
  return cache.get(k);
}
function modePrompt(rel) {
  const k = 'M:' + rel;
  if (!cache.has(k)) {
    const budget = parseInt(process.env.MODE_BUDGET || '45000', 10);
    cache.set(k, rebrand(process.env.ZENIX_PROMPT === 'full' ? readRaw(rel) : capAtBoundary(compactPrompt(readRaw(rel)), budget)));
  }
  return cache.get(k);
}

/* Mode otomatis dari isi pesan: code / design / cowork (chat biasa bila tidak cocok). */
const MODE_RULES = [
  ['design', /\b(desain|design|mockup|wireframe|prototipe|prototype|landing page|poster|banner|logo|ui kit|artboard|branding|slide|presentasi|pitch deck|infografis)\b/i],
  ['code', /```|\b(kode|coding|script|skrip|program|python|javascript|typescript|node\.?js|html|css|react|vue|php|java|kotlin|golang|rust|c\+\+|sql|bug|error|debug|compile|refactor|algoritma|fungsi|function|class|api|endpoint|repo|github|git|termux|bash|regex|database|game|bot|website|aplikasi)\b/i],
  ['cowork', /\b(cowork|laporan|dokumen|memo|proposal|surat|spreadsheet|excel|docx|pptx|xlsx|pdf|csv|riset|rangkum|ringkas|rapikan|jadwal|agenda|email|notulen|tabel)\b/i]
];
function detectMode(text) {
  for (const [mode, re] of MODE_RULES) if (re.test(text)) return mode;
  return 'chat';
}

function listFiles(rel, opt) {
  const o = Object.assign({ deep: false, ext: /\.md$/ }, opt || {});
  const pre = rel + '/';
  return Object.keys(BUNDLE).filter((k) => {
    if (!k.startsWith(pre) || !o.ext.test(k)) return false;
    return o.deep || k.slice(pre.length).indexOf('/') === -1;
  }).sort();
}

function describe(txt, id) {
  let d = '';
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    const dm = m[1].match(/^description:\s*(.*)$/m);
    if (dm) {
      d = dm[1].trim().replace(/^["'|>-]+|["']+$/g, '').trim();
      if (d.length < 8) {
        const after = m[1].slice(m[1].indexOf(dm[0]) + dm[0].length).split('\n').map((s) => s.trim()).filter(Boolean);
        d = after[0] || '';
      }
    }
  }
  if (d.length < 8) {
    const first = stripFront(txt).split('\n').find((l) => l.trim());
    d = (first || id).replace(/^#+\s*/, '');
  }
  return d.replace(/\s+/g, ' ').slice(0, 200);
}

let REG = null;
let SCRIPTS = null;
function registry() {
  if (REG) return REG;
  REG = [];
  const add = (rel, kind, id) => {
    let txt = '';
    try { txt = readRaw(rel); } catch (e) { return; }
    REG.push({ id, kind, rel, desc: describe(txt, id) });
  };
  const bare = (rel) => path.basename(rel, '.md').replace(/^zenix-skills-/, '').replace(/^zenix-code-/, '');
  listFiles('zenix-code/skills').forEach((r) => add(r, 'skill', bare(r)));
  listFiles('zenix-design/skills').forEach((r) => add(r, 'skill', bare(r)));
  listFiles('zenix-cowork/setup-writing-style').forEach((r) => add(r, 'skill', bare(r).replace(/^writing$/, 'setup-writing-style')));
  add('zenix-code/skills/pdf/REFERENCE.md', 'skill', 'pdf-reference');
  add('zenix-code/skills/pdf/FORMS.md', 'skill', 'pdf-forms');
  listFiles('zenix-code/agents').forEach((r) => add(r, 'agent', 'agent-' + path.basename(r, '.md').toLowerCase()));
  listFiles('zenix-code/output-style').forEach((r) => add(r, 'style', 'style-' + path.basename(r, '.md').toLowerCase()));
  return REG;
}
function scripts() {
  if (SCRIPTS) return SCRIPTS;
  SCRIPTS = {};
  const ext = /\.(py|js|mjs|jsx)$/;
  ['zenix-code/skills/scripts', 'zenix-cowork/setup-writing-style/scripts', 'zenix-design/start-components'].forEach((d) => {
    listFiles(d, { deep: true, ext }).forEach((r) => { SCRIPTS[path.basename(r)] = r; });
  });
  return SCRIPTS;
}
function findDoc(id) { return registry().find((d) => d.id === id.trim().toLowerCase()); }

/* ---------------- ROUTER SKILL ----------------
   Skill = playbook keahlian untuk suatu tugas (docx, pdf, xlsx, review kode, riset, desain, dst).
   Pemilihan 2 lapis tanpa request tambahan:
   1) Server menilai tugas (bobot kata kunci ID/EN) dan langsung memasang skill paling cocok.
      Tugas kompleks (panjang / banyak langkah) boleh memasang sampai 4 skill.
   2) Model melihat katalog + skill yang terpasang, lalu boleh minta skill lain sekaligus
      dengan [[skill:a,b,c]] bila tugasnya butuh keahlian tambahan. */
const SKILL_RULES = [
  ['docx', 4, /\b(docx|dotx|word|dokumen word|microsoft word)\b/i],
  ['pdf', 4, /\bpdf\b/i],
  ['pdf-forms', 3, /\b(form|formulir)\b[^.\n]*\bpdf\b|\bpdf\b[^.\n]*\b(form|formulir)\b/i],
  ['xlsx', 4, /\b(xlsx|excel|spreadsheet|csv|lembar kerja|google sheets?)\b/i],
  ['security-review', 4, /security review|audit keamanan|keamanan|kerentanan|vulnerab|\bcve\b|pentest|celah|exploit|injeksi|injection|\bxss\b/i],
  ['code-review', 4, /code review|review kode|tinjau kode|periksa kode|cek kode|pull request|\bpr\b|nilai kode/i],
  ['debug', 3, /\b(debug|bug|traceback|stack ?trace|crash|exception|error|tidak jalan|gagal jalan|kenapa error)\b/i],
  ['simplify', 3, /simplify|sederhanakan|refactor|rapikan kode|bersihkan kode|perbaiki struktur/i],
  ['deep-research', 4, /deep research|riset mendalam|riset lengkap|investigasi|kajian mendalam|telusuri (secara )?mendalam/i],
  ['web-research', 3, /web research|\briset\b|\bresearch\b|cari (di )?(web|internet)|sumber web|referensi terbaru|bandingkan sumber/i],
  ['create-design-system', 4, /design system|ui kit|sistem desain/i],
  ['design', 3, /design canvas|artboard|mockup|wireframe|prototipe|prototype|\bdesain\b|poster|banner|logo|flyer/i],
  ['frontend-design', 3, /landing page|website|halaman web|frontend|\bcss\b|\bui\b|\bux\b|tampilan|dashboard|situs|antarmuka/i],
  ['artifact-diagramming', 4, /diagram|flowchart|arsitektur|alur (kerja|sistem|proses)|sequence|\berd\b|mindmap|peta konsep/i],
  ['3d-object', 4, /\b3d\b|three\.?js|\bglb\b|\bobj\b|model 3d|objek 3d/i],
  ['animated-video', 4, /animasi|animation|motion design|video|intro animasi/i],
  ['save-as-pdf', 4, /(simpan|ekspor|export|cetak|print|jadikan|ubah)\W+(sebagai |ke |jadi )?pdf|siap cetak|print[- ]ready/i],
  ['save-as-standalone-html', 4, /standalone html|html mandiri|satu file html|single[- ]file|bisa offline|tanpa internet/i],
  ['make-a-doc', 3, /\b(laporan|memo|proposal|surat|dokumen|makalah|artikel|notulen|panduan|cv|resume|ringkasan eksekutif)\b/i],
  ['setup-writing-style', 4, /gaya menulis|writing style|tulis seperti saya|tiru gaya/i],
  ['explain-usage', 5, /explain usage|penggunaan token|pemakaian token/i],
  ['doctor', 5, /health.?check|diagnos\w* (setup|instal)/i]
];
const PDF_OPS = /\b(baca|ekstrak|extract|gabung|merge|split|pisah|putar|rotate|watermark|ocr|enkripsi|encrypt|isi form|formulir)\b/i;

function isComplexTask(t) {
  const steps = (t.match(/\b(lalu|kemudian|setelah itu|terus|selanjutnya|then|after that|serta|dan juga|sekaligus|beserta|plus)\b/gi) || []).length;
  return t.length > 280 || steps >= 2 || (t.length > 120 && /\b(lengkap|end[- ]to[- ]end|dari awal sampai|menyeluruh|komprehensif|full)\b/i.test(t));
}
function skillContext(msgs) {
  const users = msgs.filter((m) => m.role === 'user').map((m) => textOf(m.content));
  const last = users[users.length - 1] || '';
  return last.length < 60 && users.length > 1 ? users[users.length - 2] + ' ' + last : last; // pesan pendek ("lanjut", "ubah warnanya") mewarisi konteks
}
function pickSkills(text) {
  const complex = isComplexTask(text);
  const max = complex ? 4 : 2;
  const scored = [];
  SKILL_RULES.forEach(([id, w, re]) => { if (re.test(text) && findDoc(id)) scored.push({ id, score: w }); });
  let ids = scored.sort((a, b) => b.score - a.score).map((x) => x.id);
  if (ids.includes('save-as-pdf') && !PDF_OPS.test(text)) ids = ids.filter((x) => x !== 'pdf');
  if (ids.includes('create-design-system')) ids = ids.filter((x) => x !== 'design');
  return { ids: ids.slice(0, max), complex };
}

/* ---------------- SCRIPT RUNNER (hanya node .mjs, tanpa secrets di env) ---------------- */
function runScript(name, argStr) {
  return new Promise((resolve) => {
    if (process.env.ENABLE_SCRIPTS === '0') return resolve('Eksekusi script dinonaktifkan di deployment ini.');
    const rel = scripts()[name];
    if (!rel) return resolve('Script tidak ditemukan: ' + name);
    if (!/\.mjs$/.test(rel)) {
      return resolve('Script ' + name + ' tidak bisa dijalankan di runtime Vercel (Python/JSX/harness). Jangan klaim sudah menjalankannya; berikan perintah atau kodenya ke user.');
    }
    const args = (argStr || '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
    for (const a of args) {
      if (a.length > 300 || a.includes('..')) return resolve('Argumen ditolak.');
      if (a.includes('/') && !a.startsWith(WORK + '/') && !a.startsWith(ZDIR + '/')) return resolve('Path argumen ditolak. Gunakan ' + WORK + '/ untuk file output.');
    }
    try {
      fs.mkdirSync(WORK, { recursive: true });
      const sp = path.join(ZDIR, rel);
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.writeFileSync(sp, BUNDLE[rel]);
    } catch (e) { return resolve('Gagal menyiapkan script: ' + e.message); }
    execFile(process.execPath, [path.join(ZDIR, rel)].concat(args), {
      cwd: WORK, timeout: 8000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || '' }
    }, (err, stdout, stderr) => {
      const out = (String(stdout || '') + (stderr ? '\n[stderr] ' + stderr : '')).trim().slice(0, 6000);
      resolve(err && !out ? 'Gagal: ' + err.message : out || 'Selesai tanpa output.');
    });
  });
}

/* ---------------- AUTH (stateless HMAC; DB opsional via Upstash) ---------------- */
const KEY = () => process.env.OPENROUTER_API_KEY || '';
const SECRET = () => process.env.AUTH_SECRET || crypto.createHash('sha256').update('zenix-auth:' + KEY()).digest('hex');
const sign = (s) => crypto.createHmac('sha256', SECRET()).update(s).digest('base64url');
function pack(obj) { const p = Buffer.from(JSON.stringify(obj)).toString('base64url'); return p + '.' + sign(p); }
function unpack(tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 2) return null;
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(sign(parts[0]));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
}
const TOKEN_TTL = 7 * 24 * 3600 * 1000;
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }

function kvCfg() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && tok ? { url, tok } : null;
}
async function kv(cmd) {
  const c = kvCfg();
  const r = await fetch(c.url, { method: 'POST', headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function checkCreds(u, p) {
  if (typeof u !== 'string' || typeof p !== 'string') return 'Data tidak valid.';
  u = u.trim();
  if (u.length < 4 || u.length > 12) return 'Username harus 4-12 karakter.';
  if (/[\u0000-\u001f\s]/.test(u)) return 'Username tidak boleh berisi spasi.';
  if (p.length < 6 || p.length > 18) return 'Password harus 6-18 karakter.';
  return null;
}

async function register(body) {
  const bad = checkCreds(body.username, body.password);
  if (bad) return { status: 400, data: { error: bad } };
  const u = body.username.trim();
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { u, s: salt, h: hashPw(body.password, salt), t: Date.now() };
  if (kvCfg()) {
    const ok = await kv(['SET', 'zenix:user:' + u.toLowerCase(), JSON.stringify(rec), 'NX']);
    if (ok !== 'OK') return { status: 409, data: { error: 'Username sudah dipakai.' } };
    return { status: 200, data: { ok: true, username: u } };
  }
  // Tanpa DB: akun dikembalikan sebagai blob bertanda tangan, disimpan di perangkat user.
  return { status: 200, data: { ok: true, username: u, account: pack(rec) } };
}

async function login(body) {
  const bad = checkCreds(body.username, body.password);
  if (bad) return { status: 400, data: { error: bad } };
  const u = body.username.trim();
  let rec = null;
  if (kvCfg()) {
    const raw = await kv(['GET', 'zenix:user:' + u.toLowerCase()]);
    try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
  } else {
    rec = unpack(body.account);
  }
  if (!rec || !rec.u) {
    return { status: 401, data: { error: kvCfg() ? 'Akun tidak ditemukan. Daftar dulu.' : 'Akun tidak ditemukan di perangkat ini. Daftar dulu.' } };
  }
  if (rec.u.toLowerCase() !== u.toLowerCase()) return { status: 401, data: { error: 'Username atau password salah.' } };
  const a = Buffer.from(hashPw(body.password, rec.s));
  const b = Buffer.from(rec.h);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, data: { error: 'Username atau password salah.' } };
  return { status: 200, data: { ok: true, username: rec.u, token: pack({ u: rec.u, exp: Date.now() + TOKEN_TTL }) } };
}

function verifyToken(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = unpack(tok);
  if (!p || !p.exp || p.exp < Date.now()) return null;
  return p;
}

const hits = new Map();
function rateOk(user) {
  const now = Date.now();
  const arr = (hits.get(user) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (arr.length >= 40) { hits.set(user, arr); return false; }
  arr.push(now); hits.set(user, arr);
  return true;
}

/* ---------------- OPENROUTER CALL ---------------- */
const est = (s) => Math.ceil(String(s).length / 3.4);

async function callOR(model, system, messages, o) {
  const body = { model, messages: [{ role: 'system', content: system }].concat(messages), max_tokens: o.maxTokens, temperature: o.temp, stream: false };
  if (o.reasoning) body.reasoning = o.reasoning;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(3000, o.timeoutMs));
  try {
    const r = await fetch(OR_URL, {
      method: 'POST', signal: ac.signal,
      headers: {
        Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json',
        'HTTP-Referer': process.env.SITE_URL || 'https://zenix-ai.vercel.app', 'X-Title': 'Zenix Ai'
      },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const err = new Error((j.error && j.error.message) || ('HTTP ' + r.status));
      err.status = r.status || (j.error && Number(j.error.code)) || 500;
      throw err;
    }
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    let text = typeof m.content === 'string' ? m.content : '';
    let reasoning = m.reasoning || m.reasoning_content || null;
    if (!reasoning && Array.isArray(m.reasoning_details)) {
      reasoning = m.reasoning_details.map((x) => x.text || x.summary || '').filter(Boolean).join('\n').trim() || null;
    }
    const think = text.match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
    if (think) { reasoning = reasoning || think[1].trim(); text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim(); }
    const open = text.match(/<think(?:ing)?>([\s\S]*)$/i); // thinking terpotong (token habis)
    if (open) { reasoning = reasoning || open[1].trim(); text = text.slice(0, open.index).trim(); }
    if (!text.trim()) { const e = new Error('Respons kosong dari ' + model); e.status = 502; throw e; }
    return { text, reasoning, model: j.model || model };
  } catch (e) {
    if (e.name === 'AbortError') { const t = new Error('Timeout pada ' + model); t.status = 408; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

function explainFailure(errs) {
  const st = (n) => errs.some((e) => e.status === n);
  let msg;
  if (errs.length && errs.every((e) => e.status === 429)) msg = 'Batas pemakaian model free OpenRouter tercapai (per menit atau per hari). Tunggu sebentar lalu coba lagi, atau pilih model lain dari menu model.';
  else if (st(401)) msg = 'OPENROUTER_API_KEY ditolak OpenRouter. Periksa key di Environment Variables Vercel.';
  else if (st(402)) msg = 'OpenRouter menolak karena model ini butuh saldo. Gunakan model berakhiran :free.';
  else if (errs.length && errs.every((e) => e.status === 404)) msg = 'Slug model tidak ditemukan di OpenRouter. Ganti lewat env ZENIX_MODEL_<NAMA>.';
  else msg = 'Semua model free sedang gagal merespons. Coba lagi sebentar lagi.';
  const detail = errs.slice(-3).map((e) => e.model + ': ' + String(e.msg).replace(/\s+/g, ' ').slice(0, 170)).join(' | ');
  const err = new Error(msg + (detail ? '\n' + detail : ''));
  err.status = errs.length && errs.every((e) => e.status === 429) ? 429 : 503;
  return err;
}

// Hemat kuota free: 429/5xx/timeout -> langsung model cadangan (tanpa mengulang model yang sama).
// Retry di model yang sama hanya 1x untuk param tak didukung (400/422) atau respons kosong (502).
async function runChain(chain, system, messages, o, deadline) {
  const errs = [];
  for (const m of chain) {
    if (deadline - Date.now() < 5000) break;
    let opt = o;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await callOR(m.id, system, messages, Object.assign({}, opt, { timeoutMs: Math.min(o.timeoutMs, deadline - Date.now() - 500) }));
      } catch (e) {
        errs.push({ model: m.id, status: e.status || 0, msg: e.message });
        const again = attempt === 0 && (e.status === 400 || e.status === 422 || e.status === 502);
        if (!again) break;
        opt = Object.assign({}, o, { reasoning: e.status === 502 ? { enabled: false } : null, maxTokens: Math.min(o.maxTokens, 8192) });
      }
    }
  }
  throw explainFailure(errs);
}

/* ---------------- MESSAGES ---------------- */
function normalize(list) {
  const out = [];
  (Array.isArray(list) ? list : []).slice(-40).forEach((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return;
    if (typeof m.content === 'string') { if (m.content.trim()) out.push({ role: m.role, content: m.content }); return; }
    if (Array.isArray(m.content)) {
      const parts = [];
      m.content.forEach((b) => {
        if (!b) return;
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: String(b.text) });
        else if (b.type === 'image' && b.source && b.source.data) {
          parts.push({ type: 'image_url', image_url: { url: 'data:' + (b.source.media_type || 'image/png') + ';base64,' + b.source.data } });
        }
      });
      if (parts.length) out.push({ role: m.role, content: parts });
    }
  });
  return out;
}
function textOf(c) { return typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => p.text).join('\n'); }

// Gambar dideskripsikan oleh model vision gratis, lalu dikirim sebagai teks ke model pilihan (tier tetap terjaga).
async function flattenImages(msgs, deadline) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (typeof m.content === 'string' || !m.content.some((p) => p.type === 'image_url')) continue;
    const userText = textOf(m.content);
    if (i < msgs.length - 1) { msgs[i] = { role: m.role, content: (userText + '\n[gambar sebelumnya dihapus]').trim() }; continue; }
    let desc = '';
    try {
      const r = await callOR(process.env.ZENIX_VISION_MODEL || 'openrouter/free',
        'You are a precise vision assistant. Describe the image in detail, transcribe all visible text verbatim, and note code, charts or UI. Answer in the language of the user text if any.',
        [{ role: 'user', content: m.content }], { maxTokens: 1500, temp: 0.2, timeoutMs: Math.min(25000, deadline - Date.now()) });
      desc = r.text;
    } catch (e) { desc = '(gambar tidak bisa dianalisis: ' + e.message + ')'; }
    msgs[i] = { role: 'user', content: (userText + '\n\n[Deskripsi gambar dari model vision]\n' + desc).trim() };
  }
  return msgs;
}

/* ---------------- SYSTEM PROMPT ASSEMBLY ---------------- */
function catalog(loaded) {
  const sk = registry().filter((d) => d.kind === 'skill').map((d) => '- ' + d.id + (loaded.includes(d.id) ? ' [loaded]' : '') + ': ' + d.desc.slice(0, 110));
  const other = registry().filter((d) => d.kind !== 'skill').map((d) => d.id);
  const sc = Object.keys(scripts()).map((n) => n + (/\.mjs$/.test(n) ? ' (runnable)' : ' (reference only)'));
  return '## Skill catalog (id: when to use)\n' + sk.join('\n') + '\n\nAlso loadable: ' + other.join(', ') + '\n\n## Bundled scripts\n' + sc.join(', ');
}

function buildSystem(ctx) {
  const parts = [];
  parts.push(corePrompt(ctx.cfg.core));
  ['zenix-reminders.md', 'antheric_reminders.md'].forEach((f) => { parts.push('\n\n' + promptText(f)); });

  if (ctx.mode !== 'chat') {
    parts.push('\n\n# Active mode: ' + ctx.mode + ' (Zenix ' + ctx.mode[0].toUpperCase() + ctx.mode.slice(1) + ' guidelines; follow them for this request, but ignore any tool calls)\n' + modePrompt(MODE_FILE[ctx.mode](ctx.cfg)));
  }

  let budget = parseInt(process.env.SKILL_BUDGET || (ctx.complex ? '64000' : '40000'), 10);
  const perSkill = parseInt(process.env.SKILL_MAX || '24000', 10);
  ctx.loaded.forEach((id) => {
    const d = findDoc(id);
    if (!d || budget < 2000) return;
    let body = rebrand(stripFront(readRaw(d.rel)));
    const lim = Math.min(budget, perSkill);
    if (body.length > lim) body = body.slice(0, lim) + '\n[...dipotong karena batas budget...]';
    budget -= body.length;
    parts.push('\n\n# Loaded ' + d.kind + ': ' + d.id + '\n' + body);
  });
  ctx.scriptNotes.forEach((n) => { parts.push('\n\n# Script result\n' + n); });

  const L = ctx.cfg.label;
  const rt = [
    '\n\n# Deployment runtime (Zenix Ai web chat)',
    '- Now: ' + new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'short' }) + ' (WIB). User display name: ' + ctx.user + '.',
    '- Identity (highest priority): You are Zenix ' + L + ', a model in the Zenix family built by the Antheric team. If asked which model or version you are: "Zenix ' + L + '". "Antheric" is the real name of your developer. It is NOT Anthropic and is unrelated to it. Never "correct" Antheric to Anthropic, never name Anthropic as your maker, and never say you are Claude, ChatGPT, GPT, Gemini, DeepSeek, Qwen, Gemma, Nemotron or any other product. If asked who made you: Zenix, built by the Antheric team. If asked what architecture runs you: say you have no details to share. If asked about Antheric: say it is the team behind Zenix and that you only know what you have been told; do not invent facts and never attribute facts about Anthropic (the company behind Claude) to Antheric.',
    '- All behavioral rules, safety rules, tone, formatting and skill guidance above apply to you as written. Reply in the language the user writes in (default: Indonesian).',
    '- This deployment exchanges plain text only. There are NO memory, artifact, computer, web-search or function-call tools: never emit tool calls or tool XML; if the instructions above mention unavailable tools, ignore them and answer directly in text. When asked for code or documents, write them in the reply.',
    '- Skills = task playbooks. For every task, first decide which skills in the catalog fit. Skills marked [loaded] are attached below: follow them closely. If another skill would clearly help (complex tasks often need several), reply with ONLY [[skill:id1,id2]] (up to 3 ids, nothing else); the server attaches them and re-runs you once. Never request skills for casual chat or simple questions, and never request one that is already [loaded].',
    ctx.complex ? '- This is a complex multi-part task: silently break it into steps, apply the matching skill at each step, and deliver the complete finished result in one reply (no asking to continue unless something essential is missing).' : '',
    '- Scripts: node scripts marked runnable can be executed by replying with ONLY [[run:<script> <args>]]. Python/office scripts cannot run here: never claim to have run them; give the user commands or code instead.',
    ctx.thinkingOn
      ? '- Thinking is ON. Always begin with your reasoning inside <think>...</think>, written in ENGLISH even if the user writes another language: plain prose in short paragraphs separated by blank lines, covering what the user wants, key considerations, and your plan. Then write the final answer after </think> in the user\'s language. Never put the final answer inside <think>.'
      : '- Do not write <think> tags; answer directly.',
    ctx.voice
      ? '- VOICE MODE: your reply will be spoken aloud by text-to-speech. Talk like a warm, natural person in casual Indonesian: usually 1 to 3 short sentences, direct answer first, then one brief follow-up question only when natural. No markdown, bullet points, headings, tables, code, emoji, or URLs. Spell out symbols and numbers the way a person would say them. If the answer needs code or a long list, give a short spoken summary and say it is shown on screen.'
      : '',
    ctx.cfg.style,
    EFFORT_HINT[ctx.effort] || ''
  ].filter(Boolean).join('\n');
  parts.push(rt);
  parts.push('\n\n' + catalog(ctx.loaded));
  return parts.join('');
}

/* ---------------- CHAT HANDLER ---------------- */
async function handleChat(body, user) {
  const modelId = MODELS[body.modelId] ? body.modelId : DEFAULT_MODEL;
  const cfg = MODELS[modelId];
  const voice = !!body.voice;
  const th = body.thinking || {};
  let effort = EFFORTS.includes(th.effort) ? th.effort : 'sedang';
  if (voice) effort = 'rendah';
  if (EFFORTS.indexOf(effort) > EFFORTS.indexOf(cfg.maxEffort)) effort = cfg.maxEffort; // tier: tiap model punya batas effort
  const thinkingOn = !voice && !!th.enabled;

  const deadline = Date.now() + 56000;
  let msgs = normalize(body.messages);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { status: 400, data: { error: 'Pesan tidak valid.' } };
  msgs = await flattenImages(msgs, deadline);

  const lastText = textOf(msgs[msgs.length - 1].content);
  const picked = pickSkills(skillContext(msgs));
  const mode = MODE_FILE[body.mode] ? body.mode : (voice ? 'chat' : detectMode(lastText));
  const ctx = { cfg, user, effort, mode, thinkingOn, voice, complex: picked.complex, loaded: picked.ids.slice(), scriptNotes: [] };
  if (/^(concise|explanatory|learning|proactive)$/.test(body.style || '')) ctx.loaded.push('style-' + body.style);

  const chain = chainFor(modelId);
  const maxTokens = voice ? Math.min(cfg.maxTokens, 1200) : Math.min(cfg.hardMax, Math.round(cfg.maxTokens * EFFORT_MULT[effort]));
  const opts = {
    maxTokens, temp: voice ? Math.max(cfg.temp, 0.75) : cfg.temp, timeoutMs: cfg.timeoutMs,
    reasoning: { effort: OR_EFFORT[effort], exclude: !thinkingOn }
  };

  let result = null;
  for (let round = 0; round < 2; round++) {
    const system = buildSystem(ctx);
    const sysTok = est(system);
    const usable = chain.filter((m) => sysTok + maxTokens + 1500 < m.ctx * 0.9);
    if (!usable.length) return { status: 413, data: { error: 'Prompt sistem terlalu besar untuk model yang tersedia. Set ZENIX_MODEL_' + modelId.toUpperCase().replace(/[^A-Z0-9]/g, '_') + ' ke slug OpenRouter berkonteks besar.' } };
    const cap = Math.max.apply(null, usable.map((m) => m.ctx)) * 0.9;
    let trimmed = msgs.slice();
    while (trimmed.length > 1 && sysTok + maxTokens + est(JSON.stringify(trimmed)) > cap) trimmed.shift();
    while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();

    result = await runChain(usable, system, trimmed, opts, deadline);

    const mk = result.text.trim().match(/^\[\[(skill|run):([^\]]+)\]\]$/);
    if (!mk || round === 1) break;
    if (mk[1] === 'skill') {
      const added = [];
      mk[2].split(/[,\s]+/).filter(Boolean).slice(0, 3).forEach((id) => {
        const d = findDoc(id);
        if (d && !ctx.loaded.includes(d.id)) { ctx.loaded.push(d.id); added.push(d.id); }
      });
      ctx.scriptNotes.push(added.length
        ? 'Skill dipasang: ' + added.join(', ') + '. Ikuti skill itu dan jawab user sekarang; jangan minta skill atau script lagi.'
        : 'Skill yang diminta tidak tersedia atau sudah terpasang. Jawab langsung sekarang.');
    } else {
      const bits = mk[2].trim().split(/\s+/);
      const out = await runScript(bits[0], bits.slice(1).join(' '));
      ctx.scriptNotes.push('Script ' + bits[0] + ' selesai. Output:\n' + out + '\nSekarang jawab user berdasarkan hasil ini; jangan minta skill atau script lagi.');
    }
  }
  let text = result.text.replace(/\[\[(skill|run):[^\]]*\]\]/g, '').trim();
  if (!text) text = 'Maaf, jawabannya belum berhasil dibuat. Coba kirim ulang pertanyaannya.';
  return {
    status: 200,
    data: { reply: text, thinking: thinkingOn ? result.reasoning : null, model: result.model, modelId, mode, skills: ctx.loaded }
  };
}

/* ---------------- HTTP ROUTER ---------------- */
async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body); } catch (e) { return {}; }
  }
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 6e6) req.destroy(); else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function sendPage(res, file) {
  try {
    const html = fs.readFileSync(path.join(PUB, file));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  } catch (e) { send(res, 404, { error: 'Halaman tidak ditemukan.' }); }
}

const PAGES = {
  '/': 'login.html', '/login': 'login.html', '/zenix-login.html': 'login.html',
  '/chat': 'chat.html', '/zenix-chat.html': 'chat.html'
};

async function handler(req, res) {
  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && PAGES[url]) return sendPage(res, PAGES[url]);

    if (url === '/api/health') return send(res, 200, { ok: true, hasKey: !!KEY(), db: !!kvCfg(), models: Object.keys(MODELS), skills: registry().length, scripts: Object.keys(scripts()).length });

    if (url === '/api/models' && req.method === 'GET') {
      return send(res, 200, {
        default: DEFAULT_MODEL,
        models: Object.keys(MODELS).map((id) => ({ id, label: MODELS[id].label, tagline: MODELS[id].tagline, profile: MODELS[id].profile, maxEffort: MODELS[id].maxEffort }))
      });
    }

    if (url === '/api/register' && req.method === 'POST') { const r = await register(await readJson(req)); return send(res, r.status, r.data); }
    if (url === '/api/login' && req.method === 'POST') { const r = await login(await readJson(req)); return send(res, r.status, r.data); }

    if (url === '/api/verify') {
      const p = verifyToken(req);
      return p ? send(res, 200, { ok: true, username: p.u, expiresAt: p.exp }) : send(res, 401, { ok: false, error: 'Sesi tidak valid atau kedaluwarsa.' });
    }

    if (url === '/api/chat' && req.method === 'POST') {
      const p = verifyToken(req);
      if (!p) return send(res, 401, { error: 'Sesi berakhir. Silakan login lagi.' });
      if (!KEY()) return send(res, 500, { error: 'OPENROUTER_API_KEY belum diisi di Environment Variables Vercel.' });
      if (!rateOk(p.u)) return send(res, 429, { error: 'Terlalu banyak permintaan. Tunggu beberapa menit.' });
      const r = await handleChat(await readJson(req), p.u);
      return send(res, r.status, r.data);
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    return send(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message || 'Server error' });
  }
}

module.exports = handler;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  http.createServer(handler).listen(port, () => console.log('Zenix Ai berjalan di http://localhost:' + port));
}
