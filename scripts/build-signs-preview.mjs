import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const GROUP_INDEX_PATH = path.join(ROOT, "data", "sign-groups", "index.json");
const OUTPUT_PATH = path.join(ROOT, "dist", "signs-preview.html");

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildHtml(data) {
  const payload = JSON.stringify(data);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signs Preview</title>
  <style>
    :root {
      --bg: #f4efe4;
      --paper: #fffdf8;
      --ink: #1d1d1b;
      --muted: #706a60;
      --line: #ddd3c5;
      --accent: #bd4b33;
      --chip: #efe5d8;
      --shadow: 0 14px 40px rgba(35, 31, 24, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, #f8dbc2 0, transparent 24rem),
        linear-gradient(180deg, #f6f1e8 0%, #efe6d7 100%);
    }
    .page {
      width: min(1280px, calc(100% - 24px));
      margin: 0 auto;
      padding: 20px 0 40px;
    }
    .hero, .card {
      background: var(--paper);
      border: 1px solid rgba(29, 29, 27, 0.08);
      border-radius: 22px;
      box-shadow: var(--shadow);
    }
    .hero {
      padding: 24px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(30px, 4vw, 50px);
      line-height: 0.95;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1.4fr 180px 180px 180px 180px;
      gap: 12px;
      margin-top: 18px;
    }
    .control {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px 14px;
      background: #fff;
      font: inherit;
      color: var(--ink);
    }
    .stats {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .chip {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      background: var(--chip);
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
    }
    .card { overflow: hidden; }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.95), rgba(244,238,227,0.9));
      border-bottom: 1px solid rgba(29, 29, 27, 0.08);
    }
    .card-id {
      margin: 0;
      font-size: 28px;
      line-height: 1;
    }
    .meta {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.35;
    }
    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 8px 10px;
      background: #f5d8cf;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      height: fit-content;
    }
    .section {
      padding: 16px 18px 18px;
    }
    .section + .section {
      border-top: 1px solid rgba(29, 29, 27, 0.08);
    }
    .label {
      margin: 0 0 10px;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-weight: 700;
      color: var(--muted);
    }
    .images {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .image-box {
      width: 96px;
      min-height: 96px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 8px;
      border-radius: 18px;
      border: 1px solid rgba(29, 29, 27, 0.08);
      background: #fff;
    }
    .image-box img {
      max-width: 100%;
      max-height: 96px;
      object-fit: contain;
      display: block;
    }
    .comment {
      margin: 0;
      line-height: 1.55;
    }
    .empty {
      color: var(--muted);
      font-style: italic;
    }
    .related-list {
      display: grid;
      gap: 10px;
    }
    .related-item {
      display: grid;
      grid-template-columns: 84px 1fr;
      gap: 12px;
      align-items: center;
      padding: 10px;
      border-radius: 18px;
      border: 1px solid rgba(29, 29, 27, 0.08);
      background: #fff;
    }
    .empty-state {
      padding: 28px;
      text-align: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 22px;
      background: rgba(255,255,255,0.72);
    }
    @media (max-width: 1100px) {
      .toolbar { grid-template-columns: 1fr 1fr 1fr; }
    }
    @media (max-width: 760px) {
      .toolbar { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .page { width: min(100% - 16px, 1280px); }
      .hero { padding: 18px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="hero">
      <h1>Проверка спарсенных знаков</h1>
      <p>Локальная витрина собирается из <code>data/sign-groups/*.json</code>. Можно фильтровать знаки без картинок и проверять комментарии, внутренние ссылки и внешние связи.</p>
      <div class="toolbar">
        <input id="search" class="control" type="search" placeholder="Поиск по id, названию или комментарию">
        <select id="filter-topic" class="control"></select>
        <select id="filter-images" class="control">
          <option value="all">Любые картинки</option>
          <option value="with-images">Только с картинками</option>
          <option value="without-images">Только без картинок</option>
        </select>
        <select id="filter-related" class="control">
          <option value="all">Любые связи</option>
          <option value="with-related">Только с внешними связями</option>
          <option value="without-related">Только без внешних связей</option>
        </select>
        <select id="sort" class="control">
          <option value="id">Сортировка по id</option>
          <option value="images-desc">Больше картинок</option>
          <option value="missing-first">Сначала без картинок</option>
        </select>
      </div>
      <div id="stats" class="stats"></div>
    </section>
    <section id="grid" class="grid"></section>
  </main>
  <script>
    const signs = ${payload};
    const searchInput = document.getElementById("search");
    const topicFilter = document.getElementById("filter-topic");
    const imagesFilter = document.getElementById("filter-images");
    const relatedFilter = document.getElementById("filter-related");
    const sortSelect = document.getElementById("sort");
    const stats = document.getElementById("stats");
    const grid = document.getElementById("grid");

    function escapeHtml(value = "") {
      return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }

    function compareIds(left, right) {
      return left.id.localeCompare(right.id, "ru", { numeric: true });
    }

    function fillTopics() {
      const topics = [...new Set(signs.map((sign) => sign.topic).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
      topicFilter.innerHTML = ['<option value="all">Все группы</option>', ...topics.map((topic) => \`<option value="\${escapeHtml(topic)}">\${escapeHtml(topic)}</option>\`)].join("");
    }

    function getVisibleSigns() {
      const query = searchInput.value.trim().toLowerCase();
      const topic = topicFilter.value;
      const imageMode = imagesFilter.value;
      const relatedMode = relatedFilter.value;
      const sortMode = sortSelect.value;

      const filtered = signs.filter((sign) => {
        const haystack = [
          sign.id,
          sign.topic || "",
          sign.title || "",
          sign.comment || "",
          ...(sign.internalRefs || []),
          ...(sign.relatedIds || [])
        ].join(" ").toLowerCase();

        const hasImages = (sign.images || []).length > 0;
        const hasRelated = (sign.relatedIds || []).length > 0;

        if (query && !haystack.includes(query)) {
          return false;
        }
        if (topic !== "all" && sign.topic !== topic) {
          return false;
        }
        if (imageMode === "with-images" && !hasImages) {
          return false;
        }
        if (imageMode === "without-images" && hasImages) {
          return false;
        }
        if (relatedMode === "with-related" && !hasRelated) {
          return false;
        }
        if (relatedMode === "without-related" && hasRelated) {
          return false;
        }

        return true;
      });

      filtered.sort((a, b) => {
        if (sortMode === "images-desc") {
          return (b.images?.length || 0) - (a.images?.length || 0) || compareIds(a, b);
        }
        if (sortMode === "missing-first") {
          return (a.images?.length || 0) - (b.images?.length || 0) || compareIds(a, b);
        }
        return compareIds(a, b);
      });

      return filtered;
    }

    function renderStats(items) {
      const withoutImages = items.filter((item) => (item.images?.length || 0) === 0).length;
      const withRelated = items.filter((item) => (item.relatedIds || []).length > 0).length;
      const totalImages = items.reduce((sum, item) => sum + (item.images?.length || 0), 0);

      stats.innerHTML = [
        \`<span class="chip">Показано: <strong>\${items.length}</strong></span>\`,
        \`<span class="chip">Картинок: <strong>\${totalImages}</strong></span>\`,
        \`<span class="chip">Без картинок: <strong>\${withoutImages}</strong></span>\`,
        \`<span class="chip">С внешними связями: <strong>\${withRelated}</strong></span>\`
      ].join("");
    }

    function renderRelatedCard(card) {
      const preview = (card.images || [])
        .map((src) => \`<div class="image-box"><img loading="lazy" src="../\${src}" alt="\${card.id}"></div>\`)
        .join("");

      return \`
        <article class="related-item">
          <div class="images">\${preview || '<div class="image-box">нет</div>'}</div>
          <div>
            <div><strong>\${escapeHtml(card.id)}</strong></div>
            <div class="meta">Картинок: \${card.images?.length || 0}</div>
          </div>
        </article>
      \`;
    }

    function renderCard(sign) {
      const images = (sign.images || [])
        .map((src) => \`<div class="image-box"><img loading="lazy" src="../\${src}" alt="\${sign.id}"></div>\`)
        .join("");

      const internalRefs = (sign.internalRefs || []).length
        ? \`<div class="meta">internalRefs: \${sign.internalRefs.map((id) => escapeHtml(id)).join(", ")}</div>\`
        : '<div class="meta">internalRefs: нет</div>';

      const relatedIds = (sign.relatedIds || []).length
        ? \`<div class="meta">relatedIds: \${sign.relatedIds.map((id) => escapeHtml(id)).join(", ")}</div>\`
        : '<div class="meta">relatedIds: нет</div>';

      const relatedSection = (sign.relatedCards || []).length > 0
        ? \`
          <section class="section">
            <p class="label">Связанные карточки</p>
            <div class="related-list">\${sign.relatedCards.map(renderRelatedCard).join("")}</div>
          </section>
        \`
        : "";

      return \`
        <article class="card">
          <header class="card-head">
            <div>
              <h2 class="card-id">\${escapeHtml(sign.id)}</h2>
              <div class="meta">\${escapeHtml(sign.topic || sign.groupTitle || "Без группы")}</div>
              <div class="meta">\${escapeHtml(sign.title || "Без названия")}</div>
              <div class="meta">Основных картинок: \${sign.images?.length || 0}</div>
              \${internalRefs}
              \${relatedIds}
            </div>
            <span class="badge">\${(sign.images?.length || 0) === 0 ? "missing" : "ok"}</span>
          </header>
          <section class="section">
            <p class="label">Основные картинки</p>
            <div class="images">\${images || '<p class="comment empty">Картинок пока нет.</p>'}</div>
          </section>
          <section class="section">
            <p class="label">Комментарий</p>
            \${(sign.comment || "").trim()
              ? \`<p class="comment">\${escapeHtml(sign.comment)}</p>\`
              : '<p class="comment empty">Комментарий не найден в источнике.</p>'}
          </section>
          \${relatedSection}
        </article>
      \`;
    }

    function render() {
      const items = getVisibleSigns();
      renderStats(items);

      if (items.length === 0) {
        grid.innerHTML = '<div class="empty-state">Ничего не найдено. Ослабь фильтры.</div>';
        return;
      }

      grid.innerHTML = items.map(renderCard).join("");
    }

    fillTopics();
    searchInput.addEventListener("input", render);
    topicFilter.addEventListener("change", render);
    imagesFilter.addEventListener("change", render);
    relatedFilter.addEventListener("change", render);
    sortSelect.addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

async function main() {
  const indexRaw = await fs.readFile(GROUP_INDEX_PATH, "utf-8");
  const groups = JSON.parse(indexRaw);
  const data = [];

  for (const group of groups) {
    const groupPath = path.join(ROOT, group.file);
    const raw = await fs.readFile(groupPath, "utf-8");
    const items = JSON.parse(raw).map((item) => ({
      ...item,
      groupNumber: group.group,
      groupTitle: group.title,
      sourceFile: group.file,
      topic: item.topic || group.title,
    }));

    data.push(...items);
  }

  const html = buildHtml(data);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, html, "utf-8");
  console.log(`Preview written to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
