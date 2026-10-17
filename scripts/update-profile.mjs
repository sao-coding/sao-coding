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

// 部落格掛掉時回傳 null，README 就保留上一次的文章列表
async function getBlog() {
  try {
    const get = (path) => fetch(`${BLOG_API}${path}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json());
    const [posts, thinkings] = await Promise.all([get("/posts"), get("/thinkings")]);
    return { posts: posts.data, thinking: thinkings.data?.[0] };
  } catch (err) {
    console.warn(`blog API 取不到，略過文章更新：${err.message}`);
    return null;
  }
}

// ---------- SVG ----------
// 兩張卡片（neofetch、contributions）共用同一套終端機視窗、配色、字型

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

const THEMES = {
  dark: { bg: "#0d1117", bar: "#161b22", border: "#30363d", text: "#c9d1d9", key: "#ffa657", value: "#a5d6ff", cc: "#484f58", from: "#3382ed", to: "#f97316", track: "#21262d" },
  light: { bg: "#ffffff", bar: "#f6f8fa", border: "#d0d7de", text: "#24292f", key: "#bc4c00", value: "#0550ae", cc: "#afb8c1", from: "#1f6feb", to: "#e85d04", track: "#eaeef2" },
};

const SVG_WIDTH = 985;
const CHAR_W = 8.8; // 15px 等寬字的寬度
const LH = 20;

function line(key, value, width) {
  const dots = ".".repeat(Math.max(1, width - key.length - String(value).length - 4));
  return `<tspan class="cc">. </tspan><tspan class="key">${esc(key)}</tspan>:<tspan class="cc"> ${dots} </tspan><tspan class="value">${esc(value)}</tspan>`;
}

function header(title, width) {
  return `<tspan class="title">${esc(title)}</tspan> <tspan class="cc">${"—".repeat(Math.max(1, width - title.length - 1))}</tspan>`;
}

function textBlock(rows, x, y) {
  return rows.map((row, i) => `<tspan x="${x}" y="${y + i * LH}">${row}</tspan>`).join("\n");
}

function terminal({ height, title, theme, body, style = "", defs = "" }) {
  const c = THEMES[theme];
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${height}" viewBox="0 0 ${SVG_WIDTH} ${height}">
<style>
.t, .t tspan { font-family: 'JetBrains Mono','Cascadia Code',Consolas,'DejaVu Sans Mono',monospace; font-size: 15px; white-space: pre; }
.title { fill: ${c.to}; font-weight: 700; }
.key { fill: ${c.key}; }
.value { fill: ${c.value}; }
.cc { fill: ${c.cc}; }
.cursor { fill: ${c.text}; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
${style}
</style>
<defs>${defs}</defs>
<rect x="0.5" y="0.5" width="${SVG_WIDTH - 1}" height="${height - 1}" rx="12" fill="${c.bg}" stroke="${c.border}"/>
<path d="M0.5 12.5a12 12 0 0 1 12-12h${SVG_WIDTH - 25}a12 12 0 0 1 12 12v24h-${SVG_WIDTH - 1}z" fill="${c.bar}"/>
<line x1="0.5" y1="36.5" x2="${SVG_WIDTH - 0.5}" y2="36.5" stroke="${c.border}"/>
<circle cx="22" cy="18.5" r="6" fill="#ff5f57"/><circle cx="42" cy="18.5" r="6" fill="#febc2e"/><circle cx="62" cy="18.5" r="6" fill="#28c840"/>
<text x="${SVG_WIDTH / 2}" y="23" text-anchor="middle" class="t cc" style="font-size:13px">${esc(title)}</text>
${body}
</svg>
`;
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
        rects.push(`<rect x="${x + (i * 6 + col) * cell}" y="${y + r * cell}" width="${cell - 2}" height="${cell - 2}" rx="2"/>`);
      });
    });
  });
  return rects.join("");
}

const INFO_WIDTH = 58;

function buildNeofetch(stats, theme) {
  const c = THEMES[theme];
  const rows = [
    header("sao@coding", INFO_WIDTH),
    line("OS", "Windows 11, Proxmox VE, Debian", INFO_WIDTH),
    line("Uptime", uptime(stats.createdAt), INFO_WIDTH),
    line("Host", "MSI", INFO_WIDTH),
    line("Kernel", "Full-stack Web Developer", INFO_WIDTH),
    line("Editor", "Zed, Claude Code", INFO_WIDTH),
    "",
    line("Languages", stats.topLangs.join(", "), INFO_WIDTH),
    line("Stack.Web", "React, Next.js, TanStack Start", INFO_WIDTH),
    line("Stack.Server", "Elysia, oRPC, Drizzle, PostgreSQL", INFO_WIDTH),
    line("Homelab", "Proxmox VE, Caddy, NetBird, Docker", INFO_WIDTH),
    "",
    header("Contact", INFO_WIDTH),
    line("Email", "only@sao-x.com", INFO_WIDTH),
    line("Blog", BLOG.replace("https://", ""), INFO_WIDTH),
    line("X", "@sao_coding", INFO_WIDTH),
    line("Discord", "vx._.xv", INFO_WIDTH),
  ];

  const top = 72;
  const rightX = 390;
  const height = top + rows.length * LH + 22;
  const cell = 18;
  const logoY = top - 14 + ((rows.length - 1) * LH - 7 * cell) / 2;

  return terminal({
    height,
    theme,
    title: "sao@coding: ~ — neofetch",
    defs: `<linearGradient id="logo" gradientUnits="userSpaceOnUse" x1="34" y1="0" x2="340" y2="0"><stop offset="0" stop-color="${c.from}"/><stop offset="1" stop-color="${c.to}"/></linearGradient>`,
    body: `<g fill="url(#logo)">${pixelLogo("SAO", 34, Math.round(logoY), cell)}</g>
<text class="t" fill="${c.text}">
${textBlock(rows, rightX, top)}
</text>
<rect class="cursor" x="${rightX + (INFO_WIDTH + 1) * CHAR_W}" y="${top + (rows.length - 1) * LH - 13}" width="9" height="16"/>`,
  });
}

// github-profile-3d-contrib 的 SVG 只取 <style> 跟第一個 <g>（3D 日曆），雷達圖、圓餅圖不要
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

// 在原本「長出來」的動畫之後，讓有貢獻的柱子持續上下起伏，依欄位錯開時間變成一道波
const BOB_DIP = 0.7; // 最低縮到原本高度的 30%
const BOB_DUR = 2;
const BOB_WAVES = 2; // 整張日曆同時有幾道波
const BOB_SPLINE = 'calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"';

function addBob(calendar) {
  const barRe = /<g transform="translate\(([\d.]+) ([\d.]+)\)"><animateTransform attributeName="transform" type="translate" values="([\d.]+) ([\d.]+);([\d.]+) ([\d.]+)" dur="3s" repeatCount="1"><\/animateTransform>([\s\S]*?)<\/g>/g;
  return calendar.replace(barRe, (whole, x, _y, _x0, y0, _x1, y1, inner) => {
    const level = Number(inner.match(/cont-top-(\d)/)?.[1] ?? 0);
    if (level === 0) return whole;
    const begin = (3 + (Number(x) / 1280) * BOB_DUR * BOB_WAVES).toFixed(2);
    const yMid = (Number(y1) + (Number(y0) - Number(y1)) * BOB_DIP).toFixed(2);
    const bobMove = `<animateTransform attributeName="transform" type="translate" values="${x} ${y1};${x} ${yMid};${x} ${y1}" dur="${BOB_DUR}s" begin="${begin}s" repeatCount="indefinite" ${BOB_SPLINE}></animateTransform>`;
    const faces = inner.replace(/<animate attributeName="height" values="([\d.]+);([\d.]+)" dur="3s" repeatCount="1"><\/animate>/g, (grow, h0, h1) => {
      const hMid = (Number(h1) - (Number(h1) - Number(h0)) * BOB_DIP).toFixed(2);
      return `${grow}<animate attributeName="height" values="${h1};${hMid};${h1}" dur="${BOB_DUR}s" begin="${begin}s" repeatCount="indefinite" ${BOB_SPLINE}></animate>`;
    });
    return whole.replace(inner, faces).replace("</animateTransform>", `</animateTransform>${bobMove}`);
  });
}

const STATS_WIDTH = 40;

function buildContrib(stats, contribSvg, theme) {
  const c = THEMES[theme];
  const children = topLevelChildren(contribSvg);
  const style = children.find((x) => x.startsWith("<style"));
  const calendar = children.find((x) => x.startsWith("<g"));
  if (!style || !calendar) throw new Error("3D contrib SVG 格式跟預期不同");

  const scale = 0.75;
  const calTop = 40;
  const height = Math.round(calTop + 850 * scale + 8);

  // 右上角：日曆上方的空白
  const statRows = [
    header("Last 12 months", STATS_WIDTH),
    line("Contributions", fmt(stats.yearContributions), STATS_WIDTH),
    line("Streak.Current", `${stats.currentStreak} days`, STATS_WIDTH),
    line("Streak.Best", `${stats.longestStreak} days`, STATS_WIDTH),
    line("PRs / Issues", `${stats.pullRequests} / ${stats.issues}`, STATS_WIDTH),
    "",
    header("All time", STATS_WIDTH),
    line("Commits", fmt(stats.commits), STATS_WIDTH),
    line("Contributions", fmt(stats.contributions), STATS_WIDTH),
    line("Repos", stats.repos, STATS_WIDTH),
    line("Stars", stats.stars, STATS_WIDTH),
  ];
  const statX = SVG_WIDTH - 30 - (STATS_WIDTH + 2) * CHAR_W;
  const statY = 76;

  // 左下角：日曆下方的空白
  const langX = 34;
  const langY = height - 30 - stats.langShare.length * LH - LH;
  const nameW = 12;
  const barX = langX + (nameW + 2) * CHAR_W;
  const barW = 170;
  const langRows = [header("Languages", 33), ...stats.langShare.map((l) => `<tspan class="key">${esc(l.name.padEnd(nameW))}</tspan>`)];
  const langBars = stats.langShare
    .map((l, i) => {
      const y = langY + (i + 1) * LH - 11;
      return `<rect x="${barX}" y="${y}" width="${barW}" height="8" rx="2" fill="${c.track}"/>
<rect x="${barX}" y="${y}" width="${Math.max(2, (l.pct / 100) * barW).toFixed(1)}" height="8" rx="2" fill="${c.from}"/>
<text x="${barX + barW + 12}" y="${y + 9}" class="t value">${l.pct.toFixed(1).padStart(5)}%</text>`;
    })
    .join("\n");

  return terminal({
    height,
    theme,
    title: `sao@coding: ~/contributions — ${stats.range[0]} → ${stats.range[1]}`,
    style: style.replace(/^<style>|<\/style>$/g, ""),
    body: `<g transform="translate(4 ${calTop}) scale(${scale})">${addBob(calendar)}</g>
<text class="t" fill="${c.text}">
${textBlock(statRows, statX, statY)}
</text>
<text class="t" fill="${c.text}">
${textBlock(langRows, langX, langY)}
</text>
${langBars}`,
  });
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
await writeFile("assets/neofetch-dark.svg", buildNeofetch(stats, "dark"));
await writeFile("assets/neofetch-light.svg", buildNeofetch(stats, "light"));

// 3D 日曆要先由 github-profile-3d-contrib 產生（設定在 .github/3d-contrib.json）；沒有就沿用上次的圖
for (const theme of ["dark", "light"]) {
  const contribSvg = await readFile(`profile-3d-contrib/contrib-${theme}.svg`, "utf8").catch(() => null);
  if (contribSvg) await writeFile(`assets/contrib-${theme}.svg`, buildContrib(stats, contribSvg, theme));
}

let readme = await readFile("README.md", "utf8");
if (blog) {
  readme = replaceSection(readme, "BLOG-POSTS", postsMarkdown(blog.posts));
  readme = replaceSection(readme, "THINKING", thinkingMarkdown(blog.thinking));
  await writeFile("README.md", readme);
}

console.log(`ok: ${stats.repos} repos, ${stats.commits} commits, ${blog ? blog.posts.length : "?"} posts`);
