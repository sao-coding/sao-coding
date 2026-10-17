// 產生 neofetch 風格的 SVG，並把部落格最新文章寫進 README。
// 由 .github/workflows/profile.yml 定時執行，本機也可以跑：
//   GITHUB_TOKEN=xxx node scripts/update-profile.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";

const USER = "sao-coding";
const BLOG = "https://blog.sao-x.com";
const BLOG_API = "https://blog-api.sao-x.com/api";
const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN;

if (!TOKEN) throw new Error("需要 GITHUB_TOKEN 或 GH_STATS_TOKEN");

// 不算進「程式語言」的標記語言
const IGNORED_LANGS = new Set(["HTML", "CSS", "SCSS", "Jupyter Notebook", "MDX", "Dockerfile", "Shell", "Batchfile", "PowerShell", "ASP.NET"]);

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getGitHubStats() {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        contributionsCollection {
          contributionYears
          totalPullRequestContributions
          totalIssueContributions
          contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    { login: USER },
  );

  // 每年的 commit / contribution 加總
  let commits = 0;
  let contributions = 0;
  for (const year of user.contributionsCollection.contributionYears) {
    const { user: y } = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalCommitContributions
            restrictedContributionsCount
            contributionCalendar { totalContributions }
          }
        }
      }`,
      { login: USER, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` },
    );
    commits += y.contributionsCollection.totalCommitContributions + y.contributionsCollection.restrictedContributionsCount;
    contributions += y.contributionsCollection.contributionCalendar.totalContributions;
  }

  // 自己的 repo：星星數 + 語言
  let repos = 0;
  let stars = 0;
  const langs = new Map();
  let cursor = null;
  do {
    const { user: page } = await gql(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: OWNER, isFork: false) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
            }
          }
        }
      }`,
      { login: USER, cursor },
    );
    const r = page.repositories;
    repos = r.totalCount;
    for (const repo of r.nodes) {
      stars += repo.stargazerCount;
      for (const { size, node } of repo.languages.edges) {
        if (IGNORED_LANGS.has(node.name)) continue;
        langs.set(node.name, (langs.get(node.name) ?? 0) + size);
      }
    }
    cursor = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (cursor);

  const cc = user.contributionsCollection;
  const weeks = cc.contributionCalendar.weeks
    .map((w) => w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0))
    .slice(-26);

  // 連續貢獻天數；今天還沒 commit 不算斷
  const days = cc.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  let longestStreak = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  let currentStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) currentStreak++;
    else if (i !== days.length - 1) break;
  }

  const langTotal = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
  const langShare = [...langs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, size]) => ({ name, pct: (size / langTotal) * 100 }));
  const topLangs = langShare.slice(0, 3).map((l) => l.name);

  return {
    createdAt: new Date(user.createdAt),
    followers: user.followers.totalCount,
    commits,
    contributions,
    repos,
    stars,
    topLangs,
    langShare,
    weeks,
    yearContributions: cc.contributionCalendar.totalContributions,
    pullRequests: cc.totalPullRequestContributions,
    issues: cc.totalIssueContributions,
    currentStreak,
    longestStreak,
    range: [days[0]?.date, days.at(-1)?.date],
  };
}

async function getBlog() {
  const [posts, thinkings] = await Promise.all([
    fetch(`${BLOG_API}/posts`).then((r) => r.json()),
    fetch(`${BLOG_API}/thinkings`).then((r) => r.json()),
  ]);
  return { posts: posts.data, thinking: thinkings.data?.[0] };
}

// ---------- SVG ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");

function uptime(from) {
  const now = new Date();
  let y = now.getFullYear() - from.getFullYear();
  let m = now.getMonth() - from.getMonth();
  let d = now.getDate() - from.getDate();
  if (d < 0) { m -= 1; d += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
  if (m < 0) { y -= 1; m += 12; }
  return `${y} years, ${m} months, ${d} days`;
}

// 5x7 點陣字，用 <rect> 畫才不會因為字型不同而破圖
const GLYPHS = {
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
};

function pixelLogo(text, x, y, cell) {
  const rects = [];
  [...text].forEach((ch, i) => {
    GLYPHS[ch].forEach((row, r) => {
      [...row].forEach((px, col) => {
        if (px !== "#") return;
        const delay = ((i * 6 + col) * 0.03 + r * 0.02).toFixed(2);
        rects.push(`<rect class="px" style="animation-delay:${delay}s" x="${x + (i * 6 + col) * cell}" y="${y + r * cell}" width="${cell - 2}" height="${cell - 2}" rx="2"/>`);
      });
    });
  });
  return { svg: rects.join(""), width: (text.length * 6 - 1) * cell };
}

// 最近 26 週的 contribution 長條圖
function bars(weeks, x, y, width, height) {
  const max = Math.max(...weeks, 1);
  const step = width / weeks.length;
  return weeks
    .map((w, i) => {
      const h = Math.max(2, (w / max) * height);
      const opacity = (0.35 + 0.65 * (w / max)).toFixed(2);
      return `<rect class="bar" style="animation-delay:${(i * 0.03).toFixed(2)}s" x="${(x + i * step).toFixed(1)}" y="${(y + height - h).toFixed(1)}" width="${(step - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill-opacity="${opacity}"/>`;
    })
    .join("");
}

const WIDTH = 58; // 右欄每行字元數

function line(key, value) {
  const dots = ".".repeat(Math.max(1, WIDTH - key.length - value.length - 4));
  return `<tspan class="cc">. </tspan><tspan class="key">${esc(key)}</tspan>:<tspan class="cc"> ${dots} </tspan><tspan class="value">${esc(value)}</tspan>`;
}

function header(title) {
  return `- ${esc(title)} ${"—".repeat(WIDTH - title.length - 3)}`;
}

function buildSvg(stats, blog, theme) {
  const c = theme === "dark"
    ? { bg: "#0d1117", bar: "#161b22", border: "#30363d", text: "#c9d1d9", key: "#ffa657", value: "#a5d6ff", cc: "#484f58", from: "#3382ed", to: "#f97316", spark: "#3fb950" }
    : { bg: "#ffffff", bar: "#f6f8fa", border: "#d0d7de", text: "#24292f", key: "#bc4c00", value: "#0550ae", cc: "#afb8c1", from: "#1f6feb", to: "#e85d04", spark: "#1a7f37" };

  const info = [
    `<tspan class="title">sao@coding</tspan> ${"—".repeat(WIDTH - 11)}`,
    line("OS", "Windows 11, Proxmox VE, Debian"),
    line("Uptime", uptime(stats.createdAt)),
    line("Host", "MSI"),
    line("Kernel", "Full-stack Web Developer"),
    line("Editor", "Zed, Claude Code"),
    "",
    line("Languages.Programming", stats.topLangs.join(", ")),
    line("Stack.Web", "React, Next.js, TanStack Start"),
    line("Stack.Server", "Elysia, oRPC, Drizzle, PostgreSQL"),
    line("Homelab", "Proxmox VE, Caddy, NetBird, Docker"),
    "",
    header("Contact"),
    line("Email", "jeter.nice@gmail.com"),
    line("Blog", BLOG.replace("https://", "")),
    line("X", "@sao_coding"),
    line("Discord", "vx._.xv"),
    "",
    header("GitHub Stats"),
    line("Repos", `${stats.repos}  |  Stars: ${stats.stars}  |  Followers: ${stats.followers}`),
    line("Commits", `${fmt(stats.commits)}  |  Contributions: ${fmt(stats.contributions)}`),
    line("Blog.Posts", `${blog.posts.length}  |  Latest: ${blog.posts[0]?.createdAt.slice(0, 10) ?? "-"}`),
  ];

  const leftX = 34;
  const rightX = 390;
  const top = 74;
  const lh = 20;
  const height = top + info.length * lh + 30;

  const logo = pixelLogo("SAO", leftX, top - 14, 18);
  const barsTop = top + 7 * 18 + 70;
  const barsHeight = height - barsTop - 40;
  const barsSvg = bars(stats.weeks, leftX, barsTop, 310, barsHeight);
  const total26 = stats.weeks.reduce((a, b) => a + b, 0);
  const infoSvg = info.map((row, i) => `<tspan x="${rightX}" y="${top + i * lh}">${row}</tspan>`).join("\n");
  const cursorY = top + (info.length - 1) * lh;
  const cursorX = rightX + (WIDTH + 1) * 8.8;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="985" height="${height}" viewBox="0 0 985 ${height}" font-family="'JetBrains Mono','Cascadia Code',Consolas,'DejaVu Sans Mono',monospace" font-size="15px">
<style>
text, tspan { white-space: pre; }
.title { fill: ${c.to}; font-weight: 700; }
.key { fill: ${c.key}; }
.value { fill: ${c.value}; }
.cc { fill: ${c.cc}; }
.spark { fill: ${c.spark}; }
.px { animation: pop 0.4s ease-out both; }
@keyframes pop { from { opacity: 0; } to { opacity: 1; } }
.bar { transform-box: fill-box; transform-origin: bottom; animation: grow 0.6s ease-out both; }
@keyframes grow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
.cursor { fill: ${c.text}; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.fade { animation: fade 0.8s ease-out both; }
@keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
</style>
<defs>
  <linearGradient id="logo" gradientUnits="userSpaceOnUse" x1="34" y1="0" x2="340" y2="0">
    <stop offset="0%" stop-color="${c.from}"/>
    <stop offset="100%" stop-color="${c.to}"/>
  </linearGradient>
</defs>
<rect x="0.5" y="0.5" width="984" height="${height - 1}" rx="12" fill="${c.bg}" stroke="${c.border}"/>
<path d="M0.5 12.5a12 12 0 0 1 12-12h960a12 12 0 0 1 12 12v24h-984z" fill="${c.bar}"/>
<line x1="0.5" y1="36.5" x2="984.5" y2="36.5" stroke="${c.border}"/>
<circle cx="22" cy="18.5" r="6" fill="#ff5f57"/><circle cx="42" cy="18.5" r="6" fill="#febc2e"/><circle cx="62" cy="18.5" r="6" fill="#28c840"/>
<text x="492" y="23" text-anchor="middle" fill="${c.cc}" font-size="13px">sao@coding: ~ — neofetch</text>
<g class="fade">
<g fill="url(#logo)">${logo.svg}</g>
<text x="${leftX}" y="${barsTop - 16}" class="cc" font-size="13px">contributions · last 26 weeks · ${fmt(total26)}</text>
<g class="spark">${barsSvg}</g>
<line x1="${leftX}" y1="${barsTop + barsHeight + 0.5}" x2="${leftX + 307}" y2="${barsTop + barsHeight + 0.5}" stroke="${c.border}"/>
<text fill="${c.text}">
${infoSvg}
</text>
<rect class="cursor" x="${cursorX}" y="${cursorY - 13}" width="9" height="16"/>
</g>
</svg>
`;
}

// ---------- 3D dashboard ----------
// 從 github-profile-3d-contrib 產出的 SVG 只取 3D 日曆，原本雷達圖跟圓餅圖的位置換成自己的 HUD 面板

function topLevelChildren(svg) {
  const body = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const children = [];
  const re = /<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g;
  let depth = 0;
  let start = 0;
  let m;
  while ((m = re.exec(body))) {
    if (m[1]) {
      depth--;
      if (depth === 0) children.push(body.slice(start, re.lastIndex));
    } else {
      if (depth === 0) start = m.index;
      if (m[3]) {
        if (depth === 0) children.push(body.slice(start, re.lastIndex));
      } else depth++;
    }
  }
  return children;
}

const LANG_COLORS = { TypeScript: "#3178c6", JavaScript: "#f1e05a", Go: "#00add8", "C#": "#2bbf5a", Python: "#3572a5", Rust: "#dea584", Kotlin: "#a97bff", Java: "#b07219", "C++": "#f34b7d", PHP: "#4f5d95" };
const NEON = { cyan: "#00e5ff", magenta: "#ff3df2", yellow: "#ffc837", green: "#39ff88", text: "#e6e6ff", dim: "#6b6b8f", line: "#1f1f45" };

// 中日韓字算兩格寬，截斷標題用
function clip(text, max) {
  let w = 0;
  let out = "";
  for (const ch of text) {
    const cw = /[⺀-￿]/.test(ch) ? 2 : 1;
    if (w + cw > max) return out + "…";
    w += cw;
    out += ch;
  }
  return out;
}

function brackets(x, y, w, h, color) {
  const l = 16;
  return `<path d="M${x} ${y + l}V${y}H${x + l}M${x + w - l} ${y}H${x + w}V${y + l}M${x + w} ${y + h - l}V${y + h}H${x + w - l}M${x + l} ${y + h}H${x}V${y + h - l}" fill="none" stroke="${color}" stroke-width="2" opacity="0.8"/>`;
}

function panel(x, y, w, h, title) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#0a0a1e" fill-opacity="0.72" stroke="${NEON.line}"/>
${brackets(x, y, w, h, NEON.cyan)}
<text x="${x + 20}" y="${y + 30}" class="label">${esc(title)}</text>
<line x1="${x + 20}" y1="${y + 42}" x2="${x + w - 20}" y2="${y + 42}" stroke="${NEON.line}"/>`;
}

function buildDashboard(stats, blog, contribSvg) {
  const children = topLevelChildren(contribSvg);
  const style = children.find((c) => c.startsWith("<style"));
  const calendar = children.find((c) => c.startsWith("<g"));
  if (!style || !calendar) throw new Error("3D contrib SVG 格式跟預期不同");

  const W = 1280;
  const H = 850;

  // 右上：數字
  const sx = 760, sy = 36, sw = 484, sh = 340;
  const metrics = [
    ["CONTRIBUTIONS / 1Y", fmt(stats.yearContributions), NEON.cyan],
    ["CURRENT STREAK", `${stats.currentStreak}d`, NEON.magenta],
    ["TOTAL COMMITS", fmt(stats.commits), NEON.green],
    ["BEST STREAK / 1Y", `${stats.longestStreak}d`, NEON.yellow],
    ["STARS EARNED", fmt(stats.stars), NEON.yellow],
    ["PRS / ISSUES", `${stats.pullRequests} / ${stats.issues}`, NEON.cyan],
  ];
  const metricSvg = metrics
    .map(([label, value, color], i) => {
      const mx = sx + 24 + (i % 2) * 235;
      const my = sy + 80 + Math.floor(i / 2) * 92;
      return `<g class="rise" style="animation-delay:${(0.15 * i).toFixed(2)}s">
<text x="${mx}" y="${my}" class="label">${label}</text>
<text x="${mx}" y="${my + 46}" class="big" fill="${color}" filter="url(#glow)">${esc(value)}</text>
</g>`;
    })
    .join("\n");

  // 左下：語言 + 最新文章
  const lx = 30, ly = 548, lw = 500, lh = 274;
  let offset = 0;
  const barW = lw - 40;
  const segs = stats.langShare
    .map((l, i) => {
      const w = (l.pct / 100) * barW;
      const color = LANG_COLORS[l.name] ?? Object.values(NEON)[i % 4];
      const seg = `<rect x="${(lx + 20 + offset).toFixed(1)}" y="${ly + 60}" width="${Math.max(2, w - 2).toFixed(1)}" height="10" fill="${color}"/>`;
      offset += w;
      return seg;
    })
    .join("");
  const legend = stats.langShare
    .map((l, i) => {
      const color = LANG_COLORS[l.name] ?? Object.values(NEON)[i % 4];
      const x = lx + 20 + (i % 3) * 158;
      const y = ly + 96 + Math.floor(i / 3) * 22;
      return `<circle cx="${x + 5}" cy="${y - 5}" r="5" fill="${color}"/><text x="${x + 16}" y="${y}" class="tiny">${esc(l.name)} <tspan fill="${NEON.dim}">${l.pct.toFixed(1)}%</tspan></text>`;
    })
    .join("");
  const posts = blog.posts
    .slice(0, 3)
    .map((p, i) => {
      const y = ly + 184 + i * 28;
      return `<text x="${lx + 20}" y="${y}" class="small"><tspan fill="${NEON.green}">&gt;</tspan> <tspan fill="${NEON.dim}">${p.createdAt.slice(5, 10)}</tspan>  ${esc(clip(p.title, 46))}</text>`;
    })
    .join("\n");

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${style}
<style>
.mono, .label, .small, .tiny, .big, .cmd { font-family: 'JetBrains Mono','Cascadia Code',Consolas,'DejaVu Sans Mono',monospace; }
.label { fill: ${NEON.dim}; font-size: 13px; letter-spacing: 2px; }
.small { fill: ${NEON.text}; font-size: 15px; }
.tiny { fill: ${NEON.text}; font-size: 13px; }
.big { font-size: 40px; font-weight: 700; }
.cmd { fill: ${NEON.text}; font-size: 20px; }
.cursor { animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.rise { animation: rise 0.7s ease-out both; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.scan { animation: scan 6s linear infinite; }
@keyframes scan { from { transform: translateY(-120px); } to { transform: translateY(${H}px); } }
</style>
<defs>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
    <path d="M40 0H0V40" fill="none" stroke="#10102a" stroke-width="1"/>
  </pattern>
  <linearGradient id="scanline" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${NEON.cyan}" stop-opacity="0"/>
    <stop offset="1" stop-color="${NEON.cyan}" stop-opacity="0.07"/>
  </linearGradient>
  <filter id="glow" x="-20%" y="-40%" width="140%" height="180%">
    <feGaussianBlur stdDeviation="4" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>
<rect width="${W}" height="${H}" fill="#05050f"/>
<rect width="${W}" height="${H}" fill="url(#grid)"/>
${calendar}
<text x="40" y="52" class="cmd"><tspan fill="${NEON.green}">sao@coding</tspan><tspan fill="${NEON.dim}">:~$</tspan> gh contrib --render=3d<tspan class="cursor" fill="${NEON.cyan}"> █</tspan></text>
<text x="40" y="80" class="label">${stats.range[0]} → ${stats.range[1]}  ·  ${fmt(stats.yearContributions)} CONTRIBUTIONS</text>
${panel(sx, sy, sw, sh, "// SYSTEM STATUS")}
${metricSvg}
${panel(lx, ly, lw, lh, "// LANGUAGES")}
${segs}
${legend}
<text x="${lx + 20}" y="${ly + 150}" class="label">// LATEST LOG · blog.sao-x.com</text>
${posts}
<text x="${W - 30}" y="${H - 22}" text-anchor="end" class="label">LAST SYNC ${now} UTC · GITHUB-ACTIONS</text>
<rect class="scan" width="${W}" height="120" fill="url(#scanline)"/>
${brackets(8, 8, W - 16, H - 16, NEON.magenta)}
</svg>
`;
}

// ---------- README ----------

function replaceSection(readme, name, content) {
  const re = new RegExp(`(<!-- ${name}:START -->)[\\s\\S]*?(<!-- ${name}:END -->)`);
  if (!re.test(readme)) throw new Error(`README 找不到 ${name} 標記`);
  return readme.replace(re, `$1\n${content}\n$2`);
}

function postsMarkdown(posts) {
  return posts
    .slice(0, 6)
    .map((p) => `- \`${p.createdAt.slice(0, 10)}\` [${p.title.replace(/[[\]]/g, "")}](${BLOG}/posts/${p.slug}) <sub>#${p.category?.slug ?? "post"}</sub>`)
    .join("\n");
}

function thinkingMarkdown(t) {
  if (!t) return "";
  const text = t.content.split("\n").map((s) => s.trim()).filter(Boolean).join(" ");
  const short = [...text].length > 80 ? [...text].slice(0, 80).join("") + "…" : text;
  return `> 💭 ${short} <sub>— [${t.createdAt.slice(0, 10)}](${BLOG}/thinking)</sub>`;
}

const [stats, blog] = await Promise.all([getGitHubStats(), getBlog()]);

await mkdir("assets", { recursive: true });
await writeFile("assets/neofetch-dark.svg", buildSvg(stats, blog, "dark"));
await writeFile("assets/neofetch-light.svg", buildSvg(stats, blog, "light"));

// 3D 日曆要先由 github-profile-3d-contrib 產生；沒有的話就沿用上次的 dashboard
const contribSvg = await readFile("profile-3d-contrib/profile-night-rainbow.svg", "utf8").catch(() => null);
if (contribSvg) await writeFile("assets/dashboard.svg", buildDashboard(stats, blog, contribSvg));

let readme = await readFile("README.md", "utf8");
readme = replaceSection(readme, "BLOG-POSTS", postsMarkdown(blog.posts));
readme = replaceSection(readme, "THINKING", thinkingMarkdown(blog.thinking));
await writeFile("README.md", readme);

console.log(`ok: ${stats.repos} repos, ${stats.commits} commits, ${blog.posts.length} posts`);
