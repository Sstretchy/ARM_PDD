import fs from "node:fs/promises";
import path from "node:path";

import * as cheerio from "cheerio";

const SOURCE_URL = "https://ruspdd.com/general-provisions/1.2/";
const ROOT = process.cwd();
const OUTPUT_PATH = path.join(ROOT, "data", "concepts.json");
const SIGN_GROUP_INDEX_PATH = path.join(ROOT, "data", "sign-groups", "index.json");

function cleanText(text = "") {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function expandIdRange(startId, endId) {
  const startParts = String(startId).split(".");
  const endParts = String(endId).split(".");

  if (startParts.length !== endParts.length) {
    return [startId, endId];
  }

  const startPrefix = startParts.slice(0, -1).join(".");
  const endPrefix = endParts.slice(0, -1).join(".");
  if (startPrefix !== endPrefix) {
    return [startId, endId];
  }

  const startLast = Number(startParts.at(-1));
  const endLast = Number(endParts.at(-1));
  if (!Number.isInteger(startLast) || !Number.isInteger(endLast) || startLast > endLast) {
    return [startId, endId];
  }

  return Array.from({ length: endLast - startLast + 1 }, (_, index) => `${startPrefix}.${startLast + index}`);
}

function expandGroupedId(id) {
  if (!String(id).includes("-")) {
    return [id];
  }

  const [startId, endId] = String(id).split("-");
  return expandIdRange(startId, endId);
}

function compareIds(left, right) {
  return String(left).localeCompare(String(right), "ru", { numeric: true });
}

function extractSignRefs($node) {
  const refs = [];

  $node.find("img").each((_, img) => {
    const src = img.attribs?.src || "";
    const match = src.match(/\/(\d+(?:\.\d+)*)\//);
    if (match) {
      refs.push(match[1]);
    }
  });

  return unique(refs);
}

function extractDefinition(term, chunks) {
  const text = cleanText(chunks.join(" "));
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cleanText(text.replace(new RegExp(`^${escapedTerm}\\s*—\\s*`), ""));
}

async function fetchHtml(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}

async function loadSigns() {
  const indexRaw = await fs.readFile(SIGN_GROUP_INDEX_PATH, "utf8");
  const groups = JSON.parse(indexRaw);
  const signs = [];

  for (const group of groups) {
    const groupPath = path.join(ROOT, group.file);
    const raw = await fs.readFile(groupPath, "utf8");
    const items = JSON.parse(raw).map((item) => ({
      ...item,
      groupNumber: group.group,
      groupTitle: group.title,
    }));

    signs.push(...items);
  }

  return signs;
}

function buildLinkedSigns(signRefs, signs) {
  const linked = [];
  const seen = new Set();

  for (const ref of signRefs) {
    const exactMatches = signs.filter((sign) => sign.id === ref);
    const rangeMatches = signs.filter((sign) => sign.id !== ref && expandGroupedId(sign.id).includes(ref));
    const matches = [...exactMatches, ...rangeMatches].sort((left, right) => compareIds(left.id, right.id));

    for (const sign of matches) {
      if (seen.has(sign.id)) {
        continue;
      }

      linked.push({
        id: sign.id,
        title: sign.title || "",
        images: sign.images || [],
        groupTitle: sign.groupTitle || "",
      });
      seen.add(sign.id);
    }
  }

  return linked;
}

async function main() {
  const signs = await loadSigns();
  const html = await fetchHtml(SOURCE_URL);
  const $ = cheerio.load(html);

  const $article = $("#right h1").parent();
  const concepts = [];
  let current = null;

  $article.children().each((_, node) => {
    const $node = $(node);

    if (node.tagName === "h1") {
      return;
    }

    if ($node.is("p.date")) {
      return;
    }

    const $dfn = $node.is("p") ? $node.find("dfn").first() : null;
    const startsConcept = Boolean($dfn && $dfn.length > 0);

    if (startsConcept) {
      if (current) {
        current.definition = extractDefinition(current.term, current.definitionChunks);
        delete current.definitionChunks;
        concepts.push(current);
      }

      const term = cleanText($dfn.text());
      current = {
        slug: cleanText($dfn.attr("id") || ""),
        term,
        definitionChunks: [cleanText($node.text())],
        signRefs: extractSignRefs($node),
      };
      return;
    }

    if (!current) {
      return;
    }

    if ($node.is("p, table, ul, ol")) {
      const chunk = cleanText($node.text());
      if (chunk) {
        current.definitionChunks.push(chunk);
      }
      current.signRefs = unique([...current.signRefs, ...extractSignRefs($node)]);
    }
  });

  if (current) {
    current.definition = extractDefinition(current.term, current.definitionChunks);
    delete current.definitionChunks;
    concepts.push(current);
  }

  const enriched = concepts.map((concept) => ({
    ...concept,
    linkedSigns: buildLinkedSigns(concept.signRefs || [], signs),
  }));

  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");

  console.log(`Saved ${enriched.length} concepts to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
