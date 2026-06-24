import fs from "node:fs/promises";
import path from "node:path";

import * as cheerio from "cheerio";

const ROOT = process.cwd();
const IMPORT_ROOT = path.join(ROOT, "data", "imports", "drv");

function cleanText(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function resetDir(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
}

async function listDirs(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function absoluteUrl(url) {
  if (!url) {
    return "";
  }

  try {
    return new URL(url, "https://learn.drv.am").toString();
  } catch {
    return "";
  }
}

async function downloadImage(imageUrl, imagesDir, stem) {
  const url = absoluteUrl(imageUrl);
  if (!url) {
    return null;
  }

  const parsed = new URL(url);
  const ext = path.extname(parsed.pathname) || ".jpg";
  const imagePath = path.join(imagesDir, `${stem}${ext}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(imagePath, buffer);
  return imagePath;
}

function extractQuestionCounter($) {
  const texts = $("button, span, div")
    .map((_, node) => cleanText($(node).text()))
    .get();

  return texts.find((text) => /\d+\s*\/\s*\d+/.test(text) && text.length < 30) || "";
}

function extractOptions($, $form) {
  return $form
    .find("label.answer-option")
    .map((index, label) => {
      const $label = $(label);
      return {
        index,
        text: cleanText($label.text()),
        value: cleanText($label.attr("data-answer-value") || ""),
        isCorrect: ($label.attr("data-answer-correct") || "") === "true",
        for: cleanText($label.attr("for") || ""),
        className: cleanText($label.attr("class") || ""),
      };
    })
    .get();
}

async function rebuildGroup(groupDirName) {
  const groupDir = path.join(IMPORT_ROOT, groupDirName);
  const htmlDir = path.join(groupDir, "html");
  const imagesDir = path.join(groupDir, "images");
  await resetDir(imagesDir);

  const htmlNames = (await fs.readdir(htmlDir))
    .filter((name) => name.toLowerCase().endsWith(".html"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

  const items = [];

  for (const htmlName of htmlNames) {
    const htmlPath = path.join(htmlDir, htmlName);
    const html = await fs.readFile(htmlPath, "utf8");
    const $ = cheerio.load(html);
    const $form = $('form[id^="answers-form-"], form[action*="/test_results/"]').first();

    if ($form.length === 0) {
      continue;
    }

    const $frameRoot = $form.closest('[data-controller="checkbox"]');
    const optionsDetailed = extractOptions($, $form);
    const correctOption = optionsDetailed.find((option) => option.isCorrect)?.text || "";
    const imageElement = $form.find("img").first();
    const imageUrl = imageElement.length > 0 ? absoluteUrl(cleanText(imageElement.attr("src") || "")) : "";
    const imageAlt = imageElement.length > 0 ? cleanText(imageElement.attr("alt") || "") : "";
    const stem = path.parse(htmlName).name;
    const imagePath = await downloadImage(imageUrl, imagesDir, stem).catch(() => null);

    items.push({
      index: Number.parseInt(stem, 10) || items.length + 1,
      url: cleanText($form.attr("action") || "") || cleanText($("meta[name='title']").attr("content") || ""),
      title: cleanText($("title").text() || ""),
      testTitle: cleanText($("h1").first().text() || ""),
      groupTitle: cleanText($("h1 + span").first().text() || ""),
      questionId: cleanText(
        $form.find('input[name="question_id"]').attr("value") ||
          $form.find('input[name="test_result_item[question_id]"]').attr("value") ||
          "",
      ),
      blockId: cleanText($form.find('input[name="block_id"]').attr("value") || ""),
      questionCounter: extractQuestionCounter($),
      question: cleanText($form.find("h2").first().text() || ""),
      options: optionsDetailed.map((option) => option.text),
      optionsDetailed,
      clickedAnswer: "",
      correctOption,
      explanationLabel: cleanText($frameRoot.attr("data-checkbox-explanation-label-value") || ""),
      explanation: cleanText($frameRoot.attr("data-checkbox-explanation-value") || ""),
      imageUrl,
      imageAlt,
      imagePath: imagePath || null,
      htmlPath,
    });
  }

  const firstItem = items[0] || {};
  const sourceUrl = firstItem.url || "";
  const payload = {
    sourceUrl,
    scrapedAt: new Date().toISOString(),
    count: items.length,
    items,
  };

  await ensureDir(groupDir);
  await fs.writeFile(path.join(groupDir, "questions.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return { groupDirName, count: items.length };
}

async function main() {
  const groupDirs = (await listDirs(IMPORT_ROOT))
    .filter((name) => /^group-\d+(-am)?$/.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));

  const results = [];
  for (const groupDirName of groupDirs) {
    results.push(await rebuildGroup(groupDirName));
  }

  for (const result of results) {
    console.log(`${result.groupDirName}: ${result.count} questions rebuilt from html`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
