#!/usr/bin/env node
// 무협 웹소설 생성기 — 선협·신화 무협 ("신을 먹는 자"). 락드 canon + append-only + 연속성/재미 채점 + 100화 아크.
// dangsun.kr/novel/murim 렌더. 회귀물이 아니라 timeline 없음(WORLD 기반).
//
//   DRY_RUN=1 : 프롬프트만   FORCE=1 : 오늘 회차 있어도 강제   CLAUDE_MODEL=sonnet   NO_VERIFY=1 : 체크 끔

import { readFile, writeFile, readdir, access, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1";
const NO_VERIFY = process.env.NO_VERIFY === "1";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "opus";
const readSafe = async (p) => { try { return await readFile(p, "utf8"); } catch { return ""; } };

// ── .env + Supabase 개입(steering) ────────────────────────────
async function loadDotEnv() {
  try { await access(".env"); } catch { return; }
  for (const line of (await readFile(".env", "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
await loadDotEnv();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const STEERING_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
const NOVEL_ID = "murim";

const SERIES_TITLE = "신을 먹는 자";
const TARGET = 100;

// ── 날짜 / 회차 ───────────────────────────────────────────────
const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const dateStr = kst.toISOString().slice(0, 10);

const allMd = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}_\d+\.md$/.test(f));
const epNums = allMd.map((f) => parseInt((f.match(/_(\d+)\.md$/) || [])[1] || "0", 10)).sort((a, b) => a - b);
const lastEp = epNums.length ? epNums[epNums.length - 1] : 0;
if (allMd.some((f) => f.startsWith(`${dateStr}_`)) && process.env.FORCE !== "1") {
  console.log(`${dateStr} 회차 이미 존재 — 종료 (FORCE=1로 강제 추가)`);
  process.exit(0);
}
const nextEp = lastEp + 1;
const slug = `${dateStr}_${String(nextEp).padStart(3, "0")}`;

const ACT =
  nextEp <= 20 ? "1막 (식신의 길)" :
  nextEp <= 45 ? "2막 (무림과 신단)" :
  nextEp <= 65 ? "3막 (굶주림의 대가)" :
  nextEp <= 85 ? "4막 (근원)" : "5막 (포식의 끝)";
const PACING =
  nextEp >= 96 ? "최종부: 결말로 수렴. 미해결 떡밥 회수, 신규 떡밥·인물 금지." :
  nextEp >= 86 ? "막바지: 떡밥 수렴 시작, 신규 인물·설정 최소, 새 대형 떡밥 금지." :
  nextEp >= 66 ? "후반: 새 대형 떡밥 자제, 열린 떡밥 회수 우선." :
  "전개: 떡밥을 적절히 깔되 회수 리듬 유지. 막 경계(20/45/65/85화)에서 국면 도약.";

// ── 직전 화 ───────────────────────────────────────────────────
const bodyOf = (md) => { const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/); return (m ? m[1] : md).replace(/<\/?div[^>]*>/g, "").trim(); };
const lastFile = allMd.sort().reverse()[0];
const lastBody = lastFile ? bodyOf(await readSafe(lastFile)) : "";

// ── 캐논 ──────────────────────────────────────────────────────
const PREMISE = await readSafe("canon/premise.md");
const ARC = await readSafe("canon/arc.md");
const REVIEW = await readSafe("review.md");          // 편집자 리뷰 — 다음 화 생성 지침 자동 반영(자가발전)
const reviewGuide = (() => {
  const m = REVIEW.match(/##\s*다음 화 생성 지침\s*([\s\S]*?)(?:\n##\s|$)/);
  return m ? m[1].trim() : "";
})();
const WORLD = await readSafe("canon/world.md");
let charFiles = [];
try { charFiles = (await readdir("canon/characters")).filter((f) => f.endsWith(".md")); } catch {}
const characters = [];
for (const f of charFiles) characters.push({ name: f.replace(/\.md$/, ""), md: await readSafe(`canon/characters/${f}`) });
const CHARS_FULL = characters.map((c) => c.md).join("\n\n");
const THREADS = await readSafe("canon/threads.md");
const STATE = await readSafe("state.md");
const SYNOPSIS = await readSafe("synopsis.md");
const synopsisTail = SYNOPSIS.split(/\r?\n/).filter((l) => l.trim().startsWith("-")).slice(-12).join("\n");

if (!WORLD || !STATE) { console.error("canon/world.md 또는 state.md 가 없음 — 시드를 먼저"); process.exit(1); }

// ── 독자 개입 (Supabase, novel_id=murim 스코핑) ──────────────
async function fetchSteering() {
  if (!STEERING_ENABLED) return [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/novel_steering?status=eq.pending&novel_id=eq.${NOVEL_ID}&order=created_at.asc&select=id,note`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!r.ok) { console.warn(`개입 fetch HTTP ${r.status}`); return []; }
    return await r.json();
  } catch (e) { console.warn(`개입 fetch 오류: ${e.message}`); return []; }
}
async function markApplied(ids) {
  if (!STEERING_ENABLED || !ids.length) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/novel_steering?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status: "applied", applied_episode: slug, applied_at: new Date().toISOString() }),
    });
  } catch (e) { console.warn(`applied 오류: ${e.message}`); }
}
const steering = await fetchSteering();
const steeringText = steering.map((s, i) => `${i + 1}. ${String(s.note).trim()}`).join("\n");

const STYLE = `# 선협·신화 무협 문법 — 재미가 1순위 (반드시 준수)
- **첫 3줄 후킹**: 즉시 끌어당겨라(포식 장면/사패성/위기). 풍경 묘사로 느리게 시작 금지.
- **사이다 ≥ 1**: 매 화 1회 이상, [[묵야]]가 강자(신·요괴·고수)를 압도하거나 먹어 도약하는 통쾌함.
- **절단신공**: 마지막 1~2문장은 강한 훅/반전/위기로 끊기.
- **문체**: 짧고 빠른 문장, 대사·행동 중심. 무협 특유의 결(초식·기·살기)은 살리되 묘사 과잉 금지. 사패성(차갑고 가차없음) 유지.
- **차별점(THE HOOK)**: '신을 먹는 식신자 + 포식의 대가(굶주림)'를 매 화 살려라. 정파 협객 클리셰로 회귀 금지.
- 분량: 본문 2500~3500자. 시점: [[묵야]] 밀착.
- 연속성 최우선: 캐논(프리미스·세계관·인물)과 한 줄도 모순 금지.
- 금지: 작가 메타발언, 회차 요약식 서술, "다음 화에 계속" 안내문. 순수 소설 텍스트만.`;

function buildPrompt(retryNote) {
  return `**중요 — *채팅 응답* 형식. 도구·검색·파일시스템 금지. 응답은 한 덩어리 JSON만. 첫 글자 \`{\`. 인사·보고문 금지.**

당신은 한국 무협 웹소설 전문 작가입니다. 연재작 "${SERIES_TITLE}"의 **${nextEp}화**를 캐논과 직전 화에 완벽히 연속되게 쓰고, 캐논 갱신분을 함께 반환합니다.

# 🔥 이 작품의 한 끗 — 매 화 유지·강화
${PREMISE || "(없음)"}

# 📐 아크·페이싱 — 시즌1 100화
- 현재 **${nextEp}/${TARGET}화 · ${ACT}** · 페이싱: ${PACING}
- 비트(결말 '비밀'은 본문 직접 노출 금지 — 방향·복선만):
${ARC || "(없음)"}

# 🔒 캐논 — 절대 모순 금지 (읽기 전용)
## 세계관·규칙
${WORLD}
## 인물
${CHARS_FULL}

# 런닝 상태 (이번 화로 갱신)
## 현재 상태(state.md)
${STATE}
## 떡밥(threads.md)
${THREADS}
## 최근 시놉시스
${synopsisTail || "(없음 — 1화)"}

# 직전 화 본문
${lastBody || "(없음 — 1화. state.md의 '다음 화 방향'으로 강렬하게 연다)"}

${steeringText ? `# ⚡ 독자(작가) 개입 — 이번 화에 반드시 반영\n${steeringText}\n→ 자연스럽게 녹이되 캐논·연속성·차별점은 유지.` : "# 독자 개입\n(없음 — state.md의 '다음 화 방향'으로 자연스럽게 이어가세요.)"}
${reviewGuide ? `# 📝 편집 지침 (최근 리뷰 반영 — 반드시 적용)\n${reviewGuide}\n` : ""}
${retryNote ? `\n# ⚠️ 직전 시도가 다음 문제를 냄 — 피해서 다시\n${retryNote}\n` : ""}
${STYLE}

# 출력 스키마 (이대로만)
\`\`\`
{
  "title": "${nextEp}화. 제목",
  "edition_note": "이 화 한 줄 소개(~60자, 스포 없이 후킹)",
  "body_md": "본문 마크다운 2500~3500자, 절단신공으로 끝",
  "synopsis_line": "이 화를 1~2문장으로 (인물은 그대로 표기)",
  "state_md": "state.md 전체 새 내용 (회차/장소/상황/소지/즉시목표 + '## 다음 화 방향')",
  "threads_md": "threads.md 전체 새 내용 (## 열림 / ## 회수). 회수는 옮기고 열린 떡밥 누락 없이 유지+추가",
  "new_characters": [{"name":"새인물","content":"---\\nstatus: 생존\\n---\\n# 이름\\n정체 1~2문장. [[관련인물]] 위키링크. 끝에 '## 변화 로그'."}],
  "character_logs": [{"name":"묵야","line":"이 화에서의 변화 한 줄"}],
  "world_appends": ["새로 확정된 세계관 규칙(있을 때만, 보통 빈 배열)"]
}
\`\`\`
주의: new_characters name 은 기존(${characters.map((c) => c.name).join(", ")})과 겹치면 안 됨(그건 character_logs). 캐논 인물 정체 변경 금지.`;
}

console.log(`[무협] 회차: ${nextEp}화 (${slug}) · 개입 ${steering.length}건 · 인물 ${characters.length} · 모델 ${CLAUDE_MODEL}`);
const prompt0 = buildPrompt("");
console.log(`Prompt: ${(Buffer.byteLength(prompt0, "utf8") / 1024).toFixed(1)} KB`);
if (DRY_RUN) { console.log("=== DRY RUN ===\n" + prompt0.slice(0, 3000) + `\n...(전체 ${prompt0.length}자)`); process.exit(0); }

function callClaude(promptText) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "text", "--allowedTools", "", "--model", CLAUDE_MODEL], { stdio: ["pipe", "pipe", "inherit"], shell: true });
    let out = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("타임아웃 5분")); }, 5 * 60 * 1000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (c) => { clearTimeout(timer); c === 0 ? resolve(out) : reject(new Error(`claude exit ${c}`)); });
    child.stdin.write(promptText); child.stdin.end();
  });
}
const parseJson = (raw, kind) => {
  const m = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
  if (!m) { console.error(`${kind} JSON 미발견:`, raw.slice(0, 500)); return null; }
  try { return JSON.parse(m[1] ?? m[0]); } catch (e) { console.error(`${kind} 파싱 실패:`, e.message, raw.slice(0, 500)); return null; }
};

async function verify(body, threadsNew) {
  if (NO_VERIFY) return { contradictions: [], ok: true };
  const v = `**채팅 응답. 도구 금지. JSON 하나만, 첫 글자 \`{\`.**
당신은 무협 웹소설 연속성 감수자입니다. [새 화]가 [캐논]·[이전 떡밥]과 모순되는지 점검.
하드(작품 깨뜨림): 세계관 규칙 위반, 인물 정체·이름·생사 모순, 열린 떡밥이 설명 없이 사라짐.
# 캐논\n## 세계관\n${WORLD}\n## 인물\n${CHARS_FULL}
# 이전 떡밥\n${THREADS}\n# 새 떡밥\n${threadsNew}\n# 새 화\n${body}
# 출력\n{ "contradictions": [ {"type":"world|character|thread","detail":"...","severity":"hard|soft"} ], "ok": true/false }`;
  let raw; try { raw = await callClaude(v); } catch (e) { console.warn(`연속성 호출 실패: ${e.message}`); return { contradictions: [], ok: true }; }
  const j = parseJson(raw, "검증"); if (!j) return { contradictions: [], ok: true };
  return { contradictions: Array.isArray(j.contradictions) ? j.contradictions : [], ok: j.ok !== false };
}
async function funScore(body) {
  if (NO_VERIFY) return { ok: true, scores: {}, fix: "" };
  const f = `**채팅 응답. 도구 금지. JSON 하나만, 첫 글자 \`{\`.**
냉정한 무협 웹소설 편집자로 [새 화]를 1~5점 채점(후하게 X).
- hook(첫3줄 후킹) cider(포식·압도 사이다) cliff(절단신공) pace(속도·대사) distinct(식신/굶주림 차별점이 사는가)
# 한 끗\n${PREMISE}\n# 새 화\n${body}
# 출력\n{ "hook":n,"cider":n,"cliff":n,"pace":n,"distinct":n,"verdict":"pass|weak","fix":"약하면 처방 1~2줄, 좋으면 빈문자열" }
판정: hook<3 또는 cider<3 또는 distinct<3 또는 합<16 이면 weak.`;
  let raw; try { raw = await callClaude(f); } catch (e) { console.warn(`재미 호출 실패: ${e.message}`); return { ok: true, scores: {}, fix: "" }; }
  const j = parseJson(raw, "재미"); if (!j) return { ok: true, scores: {}, fix: "" };
  const s = { hook: +j.hook || 0, cider: +j.cider || 0, cliff: +j.cliff || 0, pace: +j.pace || 0, distinct: +j.distinct || 0 };
  const sum = s.hook + s.cider + s.cliff + s.pace + s.distinct;
  const weak = j.verdict === "weak" || s.hook < 3 || s.cider < 3 || s.distinct < 3 || sum < 16;
  return { ok: !weak, scores: s, sum, fix: String(j.fix || "").trim() };
}

let data = null, verdict = null, fun = null;
for (let attempt = 0; attempt < 2; attempt++) {
  let retryNote = "";
  if (attempt > 0) {
    const notes = (verdict?.contradictions || []).filter((c) => c.severity === "hard").map((c) => `- [모순/${c.type}] ${c.detail}`);
    if (fun && !fun.ok) notes.push(`- [재미] ${JSON.stringify(fun.scores)} — ${fun.fix || "후킹·사이다·차별점 강화"}`);
    retryNote = notes.join("\n");
  }
  console.log(attempt === 0 ? "생성 호출..." : "재생성(모순/재미 보강)...");
  const raw = await callClaude(buildPrompt(retryNote));
  const d = parseJson(raw, "생성");
  if (!d || !d.body_md || String(d.body_md).trim().length < 400) { console.error("본문 부실 — 재시도"); continue; }
  const body = String(d.body_md).trim();
  [verdict, fun] = await Promise.all([verify(body, String(d.threads_md || THREADS)), funScore(body)]);
  const hard = verdict.contradictions.filter((c) => c.severity === "hard");
  console.log(`  연속성: 모순 ${verdict.contradictions.length}(하드 ${hard.length}) · 재미: ${fun.ok ? "pass" : "weak"} ${JSON.stringify(fun.scores)}${fun.sum ? " 합 " + fun.sum : ""}`);
  data = d;
  if (!hard.length && fun.ok) break;
  if (attempt === 1) { if (hard.length) console.warn("⚠️ 하드 모순 잔존"); if (!fun.ok) console.warn(`⚠️ 재미 미달 잔존(합 ${fun.sum})`); }
}
if (!data) { console.error("생성 실패"); process.exit(1); }

const title = String(data.title || `${nextEp}화`).trim();
const note = String(data.edition_note || "").replaceAll('"', "'").trim();
const bodyMd = String(data.body_md).trim();
const heroTitle = title.replace(/^(\d+화)\.?\s*/, "$1 <em>").replace(/$/, "</em>");
await writeFile(`${slug}.md`, `---
title: ${title}
eyebrow: 무협 · 매일 연재
hero_title: "${heroTitle}"
description: "${note}"
summary: ${note}
---

<div class="novel">

${bodyMd}

</div>
`);
console.log(`${slug}.md 저장 — ${title} (${bodyMd.length}자)`);

if (data.state_md && String(data.state_md).trim().length > 40) await writeFile("state.md", String(data.state_md).trim() + "\n");
if (data.threads_md && String(data.threads_md).trim().length > 20) await writeFile("canon/threads.md", String(data.threads_md).trim() + "\n");

const stripSyn = (s) => String(s).trim().replace(/^\d{4}-\d{2}-\d{2}_\d+\s*\([^)]*\)\s*[:：]\s*/, "").replace(/^\d+\s*화\s*[.:：]\s*/, "");
const stripLog = (s) => String(s).trim().replace(/^\d+\s*화\s*[:：.]\s*/, "");
if (data.synopsis_line) await writeFile("synopsis.md", SYNOPSIS.replace(/\s*$/, "") + "\n" + `- **${slug} (${title})**: ${stripSyn(data.synopsis_line)}` + "\n");

async function appendBullets(path, items) {
  const arr = (items || []).map((s) => String(s).trim()).filter(Boolean);
  if (!arr.length) return;
  const cur = await readSafe(path);
  await writeFile(path, cur.replace(/\s*$/, "") + "\n" + arr.map((s) => `- ${s}`).join("\n") + "\n");
  console.log(`  ${path} +${arr.length}`);
}
await appendBullets("canon/world.md", data.world_appends);

const existingNames = new Set(characters.map((c) => c.name));
for (const nc of data.new_characters || []) {
  const nm = String(nc?.name || "").trim();
  if (!nm || existingNames.has(nm) || /[\\/:*?"<>|]/.test(nm)) continue;
  try { await mkdir("canon/characters", { recursive: true }); } catch {}
  try { await access(`canon/characters/${nm}.md`); continue; } catch {}
  await writeFile(`canon/characters/${nm}.md`, String(nc.content || `# ${nm}\n\n## 변화 로그\n`).trim() + "\n");
  existingNames.add(nm); console.log(`  +인물 ${nm}`);
}
for (const cl of data.character_logs || []) {
  const nm = String(cl?.name || "").trim(); const line = String(cl?.line || "").trim();
  if (!nm || !line || !existingNames.has(nm)) continue;
  const path = `canon/characters/${nm}.md`; const cur = await readSafe(path); if (!cur) continue;
  const entry = `- ${nextEp}화: ${stripLog(line)}`;
  await writeFile(path, cur.includes("## 변화 로그") ? cur.replace(/\s*$/, "") + "\n" + entry + "\n" : cur.replace(/\s*$/, "") + "\n\n## 변화 로그\n" + entry + "\n");
}

// 개입 applied
await markApplied(steering.map((s) => s.id));
if (steering.length) console.log(`개입 ${steering.length}건 applied`);

// index.md
const files = (await readdir(".")).filter((f) => /^\d{4}-\d{2}-\d{2}_\d+\.md$/.test(f));
const epNumOf = (f) => parseInt((f.match(/_(\d+)\.md$/) || [])[1] || "0", 10);
files.sort((a, b) => epNumOf(b) - epNumOf(a));
async function metaOf(file) {
  const fm = (await readSafe(file)).replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return { title: file, summary: "" };
  const t = fm[1].match(/^title:\s*(.+)$/m), s = fm[1].match(/^summary:\s*(.+)$/m);
  return { title: t ? t[1].trim() : file, summary: s ? s[1].trim() : "" };
}
const entries = await Promise.all(files.map(async (f) => {
  const so = f.replace(".md", ""); const { title: t, summary } = await metaOf(f);
  return summary ? `- [${t} — ${summary}](${so}.html)` : `- [${t}](${so}.html)`;
}));
await writeFile("index.md", `---
title: ${SERIES_TITLE}
eyebrow: DAILY · 선협 무협
hero_title: "${SERIES_TITLE}"
description: 신과 요괴가 실재하는 중원. 신을 먹어 강해지는 사패 식신자 묵야가 인간을 제물 삼는 난신들을 사냥한다. 매일 아침 한 화씩 자동 연재. (시즌1 전 ${TARGET}화)
stats:
  - num: "${files.length}/${TARGET}"
    lbl: "시즌1 회차"
  - num: "매일"
    lbl: "Daily 08:35"
  - num: "선협무협"
    lbl: "Genre"
---

## 회차 목록

${entries.join("\n")}
{:.episode-list}

*매일 08:35 KST 새 화가 자동으로 이어집니다.*

## 이 연재는

신·요괴·난신이 실재하는 중원에서, 신을 먹어 강해지는 금기의 식신자 묵야의 이야기. 직전 화와 누적 캐논(세계관·인물·아크)을 이어받아 매일 자동 생성되고, 매 화 연속성·재미 점검을 거칩니다.
`);
console.log(`index.md 갱신 (${files.length}회차)`);
