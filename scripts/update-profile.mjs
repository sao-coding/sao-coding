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
          contributionCalendar { weeks { contributionDays { contributionCount } } }
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

  const weeks = user.contributionsCollection.contributionCalendar.weeks
    .map((w) => w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0))
    .slice(-26);

  const topLangs = [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name]) => name);

  return { createdAt: new Date(user.createdAt), followers: user.followers.totalCount, commits, contributions, repos, stars, topLangs, weeks };
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

let readme = await readFile("README.md", "utf8");
readme = replaceSection(readme, "BLOG-POSTS", postsMarkdown(blog.posts));
readme = replaceSection(readme, "THINKING", thinkingMarkdown(blog.thinking));
await writeFile("README.md", readme);

console.log(`ok: ${stats.repos} repos, ${stats.commits} commits, ${blog.posts.length} posts`);
