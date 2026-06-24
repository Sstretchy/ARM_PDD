import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

import { chromium } from "playwright";

const ROOT = process.cwd();
const DEFAULT_START_URL = "https://learn.drv.am/test_modes/235/test_practice?block_id=456";
const HEADLESS = String(process.env.DRV_HEADLESS || "false").toLowerCase() === "true";
const MAX_QUESTIONS = Number(process.env.DRV_MAX_QUESTIONS || 200);
const AUTH_STATE_PATH = path.resolve(ROOT, process.env.DRV_AUTH_STATE_PATH || "data/imports/drv/auth-state.json");
const LEGACY_OUTPUT_PATH = cleanText(process.env.DRV_SCRAPE_OUTPUT || "");
const OUTPUT_ROOT_DIR = path.resolve(ROOT, process.env.DRV_OUTPUT_ROOT || "data/imports/drv");
const OUTPUT_FOLDER_NAME_FROM_ENV = cleanText(process.env.DRV_OUTPUT_FOLDER || "");
const OUTPUT_JSON_NAME = cleanText(process.env.DRV_OUTPUT_JSON_NAME || "questions.json");
const CDP_URL = cleanText(process.env.DRV_CDP_URL || "");
const SLOW_DELAY_MS = Number(process.env.DRV_SLOW_DELAY_MS || 100);
const SLOW_MO_MS = Number(process.env.DRV_SLOW_MO_MS || 0);
const QUESTION_FORM_SELECTOR = 'form[id^="answers-form-"], form[action*="/test_results/"]';
const ANSWER_FORM_SELECTOR = 'form[id^="answers-form-"]';
const NEXT_CONTROL_SELECTOR = '[data-nav-role="next"]';

let START_URL = cleanText(process.env.DRV_TEST_URL || DEFAULT_START_URL) || DEFAULT_START_URL;
let OUTPUT_PATH = path.resolve(ROOT, LEGACY_OUTPUT_PATH || "data/imports/drv/test-practice-456.json");
let OUTPUT_DIR = path.dirname(OUTPUT_PATH);
let HTML_DIR = path.join(OUTPUT_DIR, "html");
let IMAGE_DIR = path.join(OUTPUT_DIR, "images");

function cleanText(value = "") {
  return String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function absoluteUrl(url, baseUrl) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

async function saveJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function sanitizePathSegment(value) {
  return cleanText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\.+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeStartUrl(value) {
  const url = cleanText(value) || DEFAULT_START_URL;

  try {
    return new URL(url).toString();
  } catch {
    throw new Error(`Invalid DRV test URL: ${url}`);
  }
}

function normalizeBlockId(value, fallback) {
  const normalized = cleanText(value);
  if (!normalized) {
    return fallback;
  }

  const blockId = Number(normalized);
  if (!Number.isFinite(blockId) || blockId <= 0) {
    throw new Error(`Invalid block id: ${value}`);
  }

  return blockId;
}

function buildDefaultOutputFolderName(startUrl = START_URL) {
  const blockIdMatch = startUrl.match(/block_id=(\d+)/);
  const blockId = blockIdMatch?.[1] || "drv";
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  return `block-${blockId}-${stamp}`;
}

function setOutputLocations(folderName) {
  const safeFolderName = sanitizePathSegment(folderName) || buildDefaultOutputFolderName();
  OUTPUT_DIR = path.join(OUTPUT_ROOT_DIR, safeFolderName);
  OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_JSON_NAME);
  HTML_DIR = path.join(OUTPUT_DIR, "html");
  IMAGE_DIR = path.join(OUTPUT_DIR, "images");
  return {
    folderName: safeFolderName,
    outputDir: OUTPUT_DIR,
    outputPath: OUTPUT_PATH,
  };
}

async function resolveOutputLocations() {
  START_URL = normalizeStartUrl(START_URL);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return setOutputLocations(OUTPUT_FOLDER_NAME_FROM_ENV || buildDefaultOutputFolderName(START_URL));
  }

  const defaultStartUrl = START_URL;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const urlAnswer = await rl.question(`Start URL [${defaultStartUrl}]: `);
    START_URL = normalizeStartUrl(urlAnswer || defaultStartUrl);

    if (OUTPUT_FOLDER_NAME_FROM_ENV) {
      return setOutputLocations(OUTPUT_FOLDER_NAME_FROM_ENV);
    }

    const defaultFolderName = buildDefaultOutputFolderName(START_URL);
    const folderAnswer = await rl.question(
      `Output folder name inside ${path.relative(ROOT, OUTPUT_ROOT_DIR) || "."} [${defaultFolderName}]: `,
    );
    return setOutputLocations(folderAnswer || defaultFolderName);
  } finally {
    rl.close();
  }
}

async function savePageHtml(page, index) {
  const htmlPath = path.join(HTML_DIR, `${String(index).padStart(3, "0")}.html`);
  await fs.writeFile(htmlPath, await page.content(), "utf8");
  return htmlPath;
}

async function saveDebugHtml(page, name) {
  const filePath = path.join(OUTPUT_DIR, `${name}.html`);
  await fs.writeFile(filePath, await page.content(), "utf8");
  return filePath;
}

async function slowDown(page, multiplier = 1) {
  await page.waitForTimeout(Math.max(0, Math.round(SLOW_DELAY_MS * multiplier)));
}

async function downloadImage(url, index) {
  if (!url) {
    return null;
  }

  const parsed = new URL(url);
  const extFromPath = path.extname(parsed.pathname) || ".bin";
  const fileName = `${String(index).padStart(3, "0")}${extFromPath}`;
  const filePath = path.join(IMAGE_DIR, fileName);

  if (await fileExists(filePath)) {
    return filePath;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download image ${url}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  return filePath;
}

async function waitForPracticeReady(page, timeout = 120000) {
  await page.waitForURL((url) => !url.pathname.includes("/accounts/sign_in"), { timeout }).catch(() => null);
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => null);
  await page.locator(QUESTION_FORM_SELECTOR).first().waitFor({ state: "visible", timeout });
}

async function waitForManualLogin(page, context) {
  console.log("Manual login required.");
  console.log("A browser window is open. Sign in on drv.am and navigate back to the practice page.");
  console.log(`Waiting for the practice form to appear on ${START_URL}`);

  await waitForPracticeReady(page, 0);
  await context.storageState({ path: AUTH_STATE_PATH });

  console.log(`Saved authenticated session to ${AUTH_STATE_PATH}`);
}

async function ensureAuthenticated(page, context) {
  await page.goto(START_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => null);

  if (page.url().includes("/accounts/sign_in")) {
    if (HEADLESS) {
      throw new Error("DRV_HEADLESS=true but manual login is required. Set DRV_HEADLESS=false for the first run.");
    }

    await waitForManualLogin(page, context);
    return;
  }

  await page.locator(QUESTION_FORM_SELECTOR).first().waitFor({ state: "visible", timeout: 30000 });
}

async function captureQuestion(page) {
  return page.evaluate(() => {
    const clean = (value = "") => String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const form =
      document.querySelector('form[id^="answers-form-"]') ||
      document.querySelector('form[action*="/test_results/"]');

    if (!(form instanceof HTMLFormElement)) {
      return null;
    }

    const frameRoot = form.closest('[data-controller="checkbox"]');
    const title = clean(document.title || "");
    const testTitle = clean(document.querySelector("h1")?.textContent || "");
    const groupTitle = clean(document.querySelector("h1 + span")?.textContent || "");
    const questionId = clean(
      form.querySelector('input[name="question_id"]')?.getAttribute("value") ||
        form.querySelector('input[name="test_result_item[question_id]"]')?.getAttribute("value") ||
        "",
    );
    const blockId = clean(form.querySelector('input[name="block_id"]')?.getAttribute("value") || "");
    const question = clean(form.querySelector("h2")?.textContent || "");
    const questionCounter =
      Array.from(document.querySelectorAll("button, span, div"))
        .map((node) => clean(node.textContent || ""))
        .find((text) => /\d+\s*\/\s*\d+/.test(text) && text.length < 30) || "";

    const options = Array.from(form.querySelectorAll("label.answer-option")).map((label, index) => ({
      index,
      text: clean(label.textContent || ""),
      value: clean(label.getAttribute("data-answer-value") || ""),
      isCorrect: label.getAttribute("data-answer-correct") === "true",
      for: clean(label.getAttribute("for") || ""),
      className: clean(label.className || ""),
    }));

    const imageElement = form.querySelector("img");
    const image = imageElement
      ? {
          src: imageElement.currentSrc || imageElement.getAttribute("src") || "",
          alt: clean(imageElement.getAttribute("alt") || ""),
          width: imageElement.naturalWidth || imageElement.width || 0,
          height: imageElement.naturalHeight || imageElement.height || 0,
        }
      : null;

    const explanationLabel = clean(frameRoot?.getAttribute("data-checkbox-explanation-label-value") || "");
    const explanationFromData = clean(frameRoot?.getAttribute("data-checkbox-explanation-value") || "");
    const explanationParagraph =
      document.querySelector(".explanation-container p") ||
      Array.from(document.querySelectorAll("p")).find((node) => {
        const parentText = clean(node.parentElement?.textContent || "");
        const marker = explanationLabel || "Объяснение";
        return parentText.includes(marker) && clean(node.textContent || "").length > 0;
      });
    const explanationVisible = clean(explanationParagraph?.textContent || "");
    const hasInstantFeedback = Boolean(
      form.querySelector("label.answer-option--correct, label.answer-option--incorrect") ||
        document.querySelector(".explanation-container"),
    );
    const hasRenderedResultOptions = Boolean(
      form.querySelector("div.answer-option--correct, div.answer-option--incorrect"),
    );

    const nextControl = document.querySelector('[data-nav-role="next"]');
    const nextEnabled =
      nextControl instanceof HTMLAnchorElement
        ? true
        : nextControl instanceof HTMLButtonElement
          ? !nextControl.disabled
          : false;
    const nextControlType = nextControl instanceof HTMLElement ? nextControl.tagName.toLowerCase() : "";
    const isAnsweredState =
      form.method.toLowerCase() === "post" && /\/test_results\/\d+\/test_result_items\/\d+/.test(form.action);

    return {
      title,
      testTitle,
      groupTitle,
      questionId,
      blockId,
      questionCounter,
      question,
      options,
      image,
      explanationLabel,
      explanationFromData,
      explanationVisible,
      hasInstantFeedback,
      hasRenderedResultOptions,
      nextEnabled,
      nextControlType,
      isAnsweredState,
      url: window.location.href,
    };
  });
}

function isAnswerSubmittedState(question) {
  return Boolean(
    question?.isAnsweredState ||
      question?.hasRenderedResultOptions ||
      question?.nextControlType === "a",
  );
}

async function clickAnyAnswer(page, previousQuestion) {
  const labels = page.locator(`${ANSWER_FORM_SELECTOR} label.answer-option`);
  const firstOption = labels.first();
  const count = await labels.count();
  if (count === 0) {
    throw new Error("Could not find a clickable answer option.");
  }

  const text = cleanText(await firstOption.textContent());
  const inputId = await firstOption.getAttribute("for");
  if (!inputId) {
    throw new Error("First answer option has no linked input.");
  }

  const formAction = await page.locator(ANSWER_FORM_SELECTOR).evaluate((form) => {
    if (!(form instanceof HTMLFormElement)) {
      return "";
    }

    return form.action;
  });

  if (!formAction) {
    throw new Error("Could not resolve answer form action.");
  }

  const prepared = await page.evaluate((id) => {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) {
      return false;
    }

    input.checked = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, inputId);

  if (!prepared) {
    throw new Error(`Could not prepare first answer option ${inputId}.`);
  }

  await page
    .waitForFunction(
      () => {
        const nextControl = document.querySelector('button[data-nav-role="next"]');
        return nextControl instanceof HTMLButtonElement && !nextControl.disabled;
      },
      undefined,
      { timeout: 5000 },
    )
    .catch(() => null);

  const submitButton = page.locator('button[data-nav-role="next"]').first();
  if ((await submitButton.count()) === 0) {
    throw new Error("Could not find submit button after selecting the answer.");
  }

  if (await submitButton.isDisabled().catch(() => true)) {
    throw new Error("Submit button stayed disabled after selecting the answer.");
  }

  const responsePromise = page
    .waitForResponse(
      (response) => response.url() === formAction && response.request().method() === "POST",
      { timeout: 10000 },
    )
    .catch(() => null);

  await submitButton.click({ timeout: 5000 });

  await responsePromise;
  await page.waitForLoadState("networkidle").catch(() => null);
  const outcome = await waitForPostSubmitState(page, previousQuestion);
  if (outcome.mode === "timeout") {
    throw new Error(`Question ${previousQuestion.questionId || "unknown"} did not switch into answered state.`);
  }

  return {
    clickedAnswer: text,
    mode: outcome.mode,
    state: outcome.state,
  };
}

async function clickNextQuestion(page) {
  await page
    .waitForFunction(
      () => {
        const nextControl = document.querySelector('[data-nav-role="next"]');
        if (!nextControl) {
          return false;
        }

        if (nextControl instanceof HTMLAnchorElement) {
          return true;
        }

        return nextControl instanceof HTMLButtonElement && !nextControl.disabled;
      },
      undefined,
      { timeout: 10000 },
    )
    .catch(() => null);

  const nextControl = page.locator(NEXT_CONTROL_SELECTOR).first();
  await nextControl.waitFor({ state: "attached", timeout: 10000 }).catch(() => null);

  if ((await nextControl.count()) === 0) {
    return { clicked: false, reason: "not_found", text: "" };
  }

  const text = cleanText(await nextControl.textContent());
  await nextControl.scrollIntoViewIfNeeded().catch(() => null);

  const controlType = await nextControl.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (controlType === "button" && (await nextControl.isDisabled().catch(() => false))) {
    return { clicked: false, reason: "disabled", text };
  }

  try {
    await nextControl.click({ timeout: 5000 });
  } catch {
    await nextControl.click({ force: true, timeout: 5000 }).catch(() => null);
  }

  await slowDown(page, 0.25);
  return { clicked: true, reason: "clicked", text };
}

function buildSignature(question) {
  return cleanText([question.questionId, question.question, question.image?.src].filter(Boolean).join(" | "));
}

function hasQuestionChanged(currentQuestion, previousQuestion) {
  if (!currentQuestion || !previousQuestion) {
    return false;
  }

  if (currentQuestion.questionId && previousQuestion.questionId) {
    return currentQuestion.questionId !== previousQuestion.questionId;
  }

  if (currentQuestion.question && previousQuestion.question) {
    return currentQuestion.question !== previousQuestion.question;
  }

  if (currentQuestion.image?.src && previousQuestion.image?.src) {
    return currentQuestion.image.src !== previousQuestion.image.src;
  }

  return buildSignature(currentQuestion) !== buildSignature(previousQuestion);
}

async function waitForPostSubmitState(page, previousQuestion, timeout = 12000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const state = await captureQuestion(page);
    if (state) {
      if (hasQuestionChanged(state, previousQuestion)) {
        return { mode: "advanced", state };
      }

      if (isAnswerSubmittedState(state)) {
        return { mode: "answered", state };
      }
    }

    await page.waitForTimeout(150);
  }

  return {
    mode: "timeout",
    state: await captureQuestion(page).catch(() => null),
  };
}

async function waitForQuestionChange(page, previousQuestion) {
  const changed = await page
    .waitForFunction(
      ({ previousQuestionId, previousQuestionText, previousImageSrc }) => {
        const clean = (value = "") => String(value).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
        const form =
          document.querySelector('form[id^="answers-form-"]') ||
          document.querySelector('form[action*="/test_results/"]');
        const currentQuestionId = clean(
          form?.querySelector('input[name="question_id"]')?.getAttribute("value") ||
            form?.querySelector('input[name="test_result_item[question_id]"]')?.getAttribute("value") ||
            "",
        );
        const currentQuestionText = clean(form?.querySelector("h2")?.textContent || "");
        const currentImageSrc = clean(form?.querySelector("img")?.getAttribute("src") || "");

        if (currentQuestionId && previousQuestionId && currentQuestionId !== previousQuestionId) {
          return true;
        }

        if (currentQuestionText && previousQuestionText && currentQuestionText !== previousQuestionText) {
          return true;
        }

        if (currentImageSrc && previousImageSrc && currentImageSrc !== previousImageSrc) {
          return true;
        }

        return false;
      },
      {
        previousQuestionId: previousQuestion.questionId || "",
        previousQuestionText: previousQuestion.question || "",
        previousImageSrc: previousQuestion.image?.src || "",
      },
      { timeout: 20000 },
    )
    .then(() => true)
    .catch(() => false);

  await page.waitForLoadState("networkidle").catch(() => null);
  await page.locator(QUESTION_FORM_SELECTOR).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => null);

  if (!changed) {
    throw new Error(
      `Question did not change after clicking next. Previous questionId=${previousQuestion.questionId || "unknown"}`,
    );
  }
}

async function scrapeQuestions(page) {
  const items = [];
  const seen = new Set();

  for (let index = 1; index <= MAX_QUESTIONS; index += 1) {
    await page.waitForLoadState("networkidle").catch(() => null);

    const before = await captureQuestion(page);
    if (!before) {
      throw new Error("Could not locate question form on the page.");
    }

    const signature = buildSignature(before);
    if (!signature) {
      throw new Error(`Question ${index}: empty signature, page structure likely changed.`);
    }

    if (seen.has(signature)) {
      console.log(`Stopped on repeated question at step ${index}.`);
      break;
    }

    seen.add(signature);
    const htmlPath = await savePageHtml(page, index);

    console.log(`Question ${index}: ${before.question || before.title}`);

    const answerResult = await clickAnyAnswer(page, before);
    const clickedAnswer = answerResult.clickedAnswer;
    const after = answerResult.state || (await captureQuestion(page));
    if (!after) {
      throw new Error(`Question ${index}: page lost question/result form after answering.`);
    }

    const imageUrl = absoluteUrl(before.image?.src || after.image?.src, page.url());
    const imagePath = imageUrl ? await downloadImage(imageUrl, index).catch(() => null) : null;

    items.push({
      index,
      url: before.url,
      title: before.title,
      testTitle: before.testTitle,
      groupTitle: before.groupTitle,
      questionId: before.questionId,
      blockId: before.blockId,
      questionCounter: before.questionCounter,
      question: before.question,
      options: before.options.map((option) => option.text),
      optionsDetailed: before.options,
      clickedAnswer,
      correctOption: before.options.find((option) => option.isCorrect)?.text || "",
      explanationLabel: after.explanationLabel || before.explanationLabel,
      explanation: after.explanationVisible || after.explanationFromData || before.explanationFromData,
      imageUrl,
      imageAlt: before.image?.alt || after.image?.alt || "",
      imagePath,
      htmlPath,
    });

    await saveJson(OUTPUT_PATH, {
      sourceUrl: START_URL,
      scrapedAt: new Date().toISOString(),
      count: items.length,
      items,
    });

    if (answerResult.mode === "answered") {
      const next = await clickNextQuestion(page);
      if (!next.clicked) {
        console.log(`Could not advance after question ${index}: ${next.reason}.`);
        break;
      }

      await waitForQuestionChange(page, before);
    }

  }

  return items;
}

async function main() {
  const outputConfig = await resolveOutputLocations();
  await ensureDir(OUTPUT_DIR);
  await ensureDir(HTML_DIR);
  await ensureDir(IMAGE_DIR);
  await ensureDir(path.dirname(AUTH_STATE_PATH));

  let browser;
  let context;
  let page;
  let ownsPage = false;

  if (CDP_URL) {
    console.log(`Connecting to existing Chrome via CDP: ${CDP_URL}`);
    browser = await chromium.connectOverCDP(CDP_URL, {
      slowMo: HEADLESS ? 0 : SLOW_MO_MS,
      timeout: 30000,
      noDefaults: true,
    });

    context = browser.contexts()[0];
    if (!context) {
      throw new Error("Connected over CDP, but no browser context was available.");
    }

    page = await context.newPage();
    ownsPage = true;
  } else {
    browser = await chromium.launch({
      channel: "chrome",
      headless: HEADLESS,
      slowMo: HEADLESS ? 0 : SLOW_MO_MS,
    });

    context = await browser.newContext(
      (await fileExists(AUTH_STATE_PATH))
        ? { storageState: AUTH_STATE_PATH, viewport: { width: 1440, height: 1200 } }
        : { viewport: { width: 1440, height: 1200 } },
    );

    page = await context.newPage();
  }

  context.setDefaultTimeout(20000);
  context.setDefaultNavigationTimeout(30000);
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);

  try {
    console.log(`Scrape start URL: ${START_URL}`);
    console.log(`Scrape output folder: ${outputConfig.outputDir}`);
    await ensureAuthenticated(page, context);
    const items = await scrapeQuestions(page);
    if (!CDP_URL) {
      await context.storageState({ path: AUTH_STATE_PATH });
    }
    console.log(`Saved ${items.length} questions to ${OUTPUT_PATH}`);
  } catch (error) {
    const debugPath = await saveDebugHtml(page, "debug-last-page").catch(() => null);
    if (debugPath) {
      console.error(`Saved debug HTML to ${debugPath}`);
    }
    throw error;
  } finally {
    if (ownsPage && page) {
      await page.close().catch(() => null);
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
