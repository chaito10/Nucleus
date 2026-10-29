#!/usr/bin/env node
/*
  tools/nucleus-catalogue.mjs — dev-time catalogue tooling for the Nucleus browser OS.

  WHAT THIS IS
    The Nucleus shell (index.html) ships as one portable HTML file and loads Store tools lazily
    from apps/*.html. Each app file owns its own metadata block, so the discovery indexes are
    GENERATED, never hand-maintained. This script is that generator plus the compliance gate.
    It is a developer tool: nothing here runs in the browser and nothing is shipped to users.

  CONTRACT SOURCE OF TRUTH
    apps/CATALOG.md. Categories, field semantics, the metadata block shape and the verification
    rules below all come from that file. Keep the two in sync.

  USAGE
    node tools/nucleus-catalogue.mjs <mode>
      --add-meta   insert the metadata block into existing apps from apps/manifest.json
      --write      regenerate apps/index/categories.json, apps/index/<slug>.json, apps/manifest.json
      --check      compliance gate; exits 1 with file:line problems
      --stats      category counts, byte totals, projected shell-metadata cost
      --help       this text

  RULES
    * Node built-ins only. No package.json, no npm, no dependencies, no build step.
    * Deterministic: stable ordering, no timestamps. Re-running --write must produce no churn.
    * Never edits index.html and never rewrites an app body: --add-meta only splices one block in.
*/

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import process from "node:process";
import { fileURLToPath } from "node:url";

/* =========================================================================
 * 1. constants (mirrors apps/CATALOG.md)
 * ======================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APPS_DIR = path.join(ROOT, "apps");
const INDEX_DIR = path.join(APPS_DIR, "index");
const CATEGORIES_PATH = path.join(INDEX_DIR, "categories.json");
const MANIFEST_FILE = path.join(APPS_DIR, "manifest.json");

/** apps/_template.html is scaffolding, not a catalogue entry. */
const TEMPLATE_NAME = "_template.html";

/** Field order inside the metadata block — stable so regenerated files never reflow. */
const FIELD_ORDER = ["id", "name", "cat", "desc", "icon", "w", "h"];

/** The nine categories from CATALOG.md, in contract order. Index files follow this order. */
const CATEGORIES = [
  "Developer Tools",
  "Security & Forensics",
  "Media & Files",
  "Data & Calculations",
  "Productivity",
  "Knowledge & Writing",
  "Everyday Utilities",
  "Education",
  "Network & System",
];

const SCHEMA_APPS = "nucleus-catalogue/v1"; /* manifest.json + apps/index/<slug>.json */
const SCHEMA_CATS = "nucleus-categories/v1"; /* apps/index/categories.json */
const META_TYPE = "application/nucleus+json";

/** CATALOG.md rule 9: keep an app under ~60 KB so first open stays instant. */
const MAX_APP_BYTES = 60 * 1024;

const ID_RE = /^[a-z0-9][a-z0-9-]*$/; /* lowercase kebab-case, same as the filename stem */

/** Accepted precedent for .innerHTML= (CATALOG.md rule 3): escape-then-allowlist Markdown preview. */
const INNERHTML_PRECEDENT = "apps/markdown-notes.html";

/* =========================================================================
 * 2. filesystem + text helpers
 * ======================================================================= */

function readText(file) {
  const buf = fs.readFileSync(file);
  const bom = buf.length > 0 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: bom ? buf.toString("utf8").slice(1) : buf.toString("utf8"), bom };
}

/** Write LF text back exactly as read (BOM preserved when present). Never a CRLF surprise. */
function writeText(file, text, bom) {
  fs.writeFileSync(file, (bom ? "\ufeff" : "") + text, "utf8");
}

function readJson(file) {
  return JSON.parse(readText(file).text);
}

/** Stable, locale-independent comparator: name, then id. Keeps --write free of churn. */
function byNameThenId(a, b) {
  const x = String(a.name).toLowerCase();
  const y = String(b.name).toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function lineText(text, index) {
  const s = text.lastIndexOf("\n", index) + 1;
  let e = text.indexOf("\n", index);
  if (e < 0) e = text.length;
  return text.slice(s, e).trim().slice(0, 160);
}

function slugOf(cat) {
  return String(cat).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Paths in the contract are POSIX and repo-relative: apps/<id>.html. */
function entryFor(id) {
  return "apps/" + id + ".html";
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

function appFiles() {
  if (!fs.existsSync(APPS_DIR)) fail("apps/ directory not found at " + APPS_DIR);
  return fs
    .readdirSync(APPS_DIR)
    .filter((f) => /\.html$/i.test(f) && f !== TEMPLATE_NAME)
    .sort();
}

function fail(msg) {
  console.error("error: " + msg);
  process.exitCode = 1;
  throw new Error(msg);
}

/* =========================================================================
 * 3. the metadata block
 * ======================================================================= */

const META_BLOCK_RE =
  /<script\b[^>]*\btype\s*=\s*["']application\/nucleus\+json["'][^>]*>([\s\S]*?)<\/script>/i;

function findMetaBlock(html) {
  const m = META_BLOCK_RE.exec(html);
  if (!m) return null;
  const bodyStart = m.index + m[0].indexOf(">") + 1;
  return { match: m[0], body: m[1], bodyStart, line: lineAt(html, bodyStart) };
}

/** Fields the contract allows, in contract order, with empty values dropped. */
function orderedMeta(e) {
  const ordered = {};
  for (const k of FIELD_ORDER) if (e[k] !== undefined && e[k] !== null && e[k] !== "") ordered[k] = e[k];
  return ordered;
}

/** Compact one-line JSON — the payload the shell actually pays for (used by --stats). */
function metaJson(e) {
  return JSON.stringify(orderedMeta(e));
}

/**
 * The in-file block, formatted exactly like the example in apps/CATALOG.md: the pairs up to and
 * including "cat" on the first line, the rest on a continuation line indented one space, so the
 * 12 converted apps and every hand-written app read the same.
 */
function metaBlock(e) {
  const parts = Object.keys(orderedMeta(e)).map((k) => JSON.stringify(k) + ":" + JSON.stringify(e[k]));
  const afterCat = parts.findIndex((p) => p.indexOf('"cat":') === 0) + 1;
  const head = parts.slice(0, Math.max(afterCat, 1)).join(",");
  const tail = parts.slice(Math.max(afterCat, 1)).join(",");
  const body = tail ? head + ",\n " + tail : head;
  return '<script type="' + META_TYPE + '">\n' + body + "\n</script>";
}

/* =========================================================================
 * 4. HTML parsing: script/style spans + length-preserving comment masking
 *
 *    Masking replaces comment bodies with spaces (newlines kept) so every index in the
 *    masked string still points at the same index in the original file. That gives us
 *    accurate file:line reporting AND lets us tell "code" from "only mentioned in a comment".
 * ======================================================================= */

function tagSpans(html, tag) {
  const spans = [];
  const openRe = new RegExp("<" + tag + "\\b([^>]*)>", "gi");
  const closeRe = new RegExp("</" + tag + "\\s*>", "i");
  let m;
  while ((m = openRe.exec(html))) {
    const bodyStart = m.index + m[0].length;
    const rest = html.slice(bodyStart);
    const cm = closeRe.exec(rest);
    if (!cm) {
      spans.push({ start: bodyStart, end: html.length, attrs: m[1] });
      break;
    }
    spans.push({ start: bodyStart, end: bodyStart + cm.index, attrs: m[1] });
    openRe.lastIndex = bodyStart + cm.index + cm[0].length;
  }
  return spans;
}

function attrValue(attrs, name) {
  const m = new RegExp("\\b" + name + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i").exec(attrs);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

/** JS/CSS/HTML comment masking. Strings and regex literals are walked past, not masked,
 *  so a "//" inside "http://x" never swallows the rest of a line. */
const REGEX_OK_BEFORE = "(,=:[!&|?{};+-*%~^<>\n";

function maskJs(src, out, start, end, depth) {
  if (depth > 8) return; /* template-in-template runaway guard */
  let prev = "";
  let i = start;
  const blank = (k) => {
    if (src[k] !== "\n") out[k] = " ";
  };
  while (i < end) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < end && src[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const stop = src.indexOf("*/", i + 2);
      const to = stop < 0 ? end : stop + 2;
      for (let k = i; k < to; k++) blank(k);
      i = to;
      prev = ";";
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, end);
      prev = "$";
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, out, i, end, depth);
      prev = "$";
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_OK_BEFORE.indexOf(prev) >= 0)) {
      const stop = skipRegex(src, i, end);
      if (stop > i) {
        i = stop;
        prev = "$";
        continue;
      }
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
}

function skipQuoted(src, i, end) {
  const q = src[i];
  let j = i + 1;
  while (j < end) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    if (src[j] === "\n") return j; /* unterminated: don't eat the file */
    j++;
  }
  return end;
}

function skipRegex(src, i, end) {
  let j = i + 1;
  let cls = false;
  while (j < end) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "\n") return i; /* not a regex after all */
    if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) return j + 1;
    j++;
  }
  return i;
}

function skipTemplate(src, out, i, end, depth) {
  let j = i + 1;
  while (j < end) {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "`") return j + 1;
    if (src[j] === "$" && src[j + 1] === "{") {
      const close = findBraceClose(src, j + 2);
      maskJs(src, out, j + 2, Math.min(close, end), depth + 1);
      j = Math.min(close, end) + 1;
      continue;
    }
    j++;
  }
  return end;
}

function findBraceClose(src, from) {
  let d = 1;
  let j = from;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(src, j, src.length);
      continue;
    }
    if (c === "`") {
      j = skipTemplate(src, src.split(""), j, src.length, 0);
      continue;
    }
    if (c === "{") d++;
    else if (c === "}") {
      d--;
      if (d === 0) return j;
    }
    j++;
  }
  return src.length;
}

function maskCss(src, out, start, end) {
  let i = start;
  while (i < end) {
    if (src[i] === "/" && src[i + 1] === "*") {
      const stop = src.indexOf("*/", i + 2);
      const to = stop < 0 ? end : stop + 2;
      for (let k = i; k < to; k++) if (src[k] !== "\n") out[k] = " ";
      i = to;
      continue;
    }
    if (src[i] === '"' || src[i] === "'") {
      i = skipQuoted(src, i, end);
      continue;
    }
    i++;
  }
}

function maskHtmlComments(src, out, start, end) {
  let i = start;
  while (i < end) {
    if (src.startsWith("<!--", i)) {
      const stop = src.indexOf("-->", i + 4);
      const to = stop < 0 ? end : stop + 3;
      for (let k = i; k < to; k++) if (src[k] !== "\n") out[k] = " ";
      i = to;
      continue;
    }
    i++;
  }
}

/** views: code = comments masked (strings intact); markup = script/style bodies masked too. */
function buildViews(html) {
  const src = html;
  const code = html.split("");
  const scriptSpans = tagSpans(html, "script");
  const styleSpans = tagSpans(html, "style");
  for (const s of scriptSpans) maskJs(src, code, s.start, s.end, 0);
  for (const s of styleSpans) maskCss(src, code, s.start, s.end);
  /* mask HTML comments only where they are not inside script/style */
  const blocked = [...scriptSpans, ...styleSpans].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const s of blocked) {
    maskHtmlComments(src, code, cursor, s.start);
    cursor = Math.max(cursor, s.end);
  }
  maskHtmlComments(src, code, cursor, src.length);
  const codeStr = code.join("");
  const markup = codeStr.split("");
  for (const s of blocked) for (let k = s.start; k < s.end; k++) if (markup[k] !== "\n") markup[k] = " ";
  return { code: codeStr, markup: markup.join("") };
}

/* =========================================================================
 * 5. inline script extraction + syntax check
 * ======================================================================= */

const JS_TYPES = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module", "text/babel"]);

function inlineScripts(html) {
  return tagSpans(html, "script")
    .filter((s) => {
      if (attrValue(s.attrs, "src")) return false; /* external script: flagged separately */
      const t = (attrValue(s.attrs, "type") || "").trim().toLowerCase();
      return t !== META_TYPE && JS_TYPES.has(t);
    })
    .map((s) => ({ start: s.start, line: lineAt(html, s.start), code: html.slice(s.start, s.end) }));
}

function syntaxErrorOf(code, filename) {
  try {
    new vm.Script(code, { filename });
    return null;
  } catch (err) {
    /* vm reports "<filename>:<line>:<col>"; translate to a file-relative line. */
    let rel = 0;
    const m = new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(\\d+)").exec(String(err.stack || "") + String(err.message || ""));
    if (m) rel = parseInt(m[1], 10) - 1;
    return { message: String(err.message || err).split("\n")[0], lineOffset: rel };
  }
}

/* =========================================================================
 * 6. scanning the apps directory — the catalogue source of truth
 * ======================================================================= */

/**
 * @returns {{apps: Array, broken: Array, problems: string[]}}
 * apps: {file, rel, id, stem, name, cat, desc, icon, w, h, entry, bytes, html, views, metaLine}
 */
function scanApps() {
  const apps = [];
  const broken = [];
  const problems = [];
  for (const file of appFiles()) {
    const abs = path.join(APPS_DIR, file);
    const { text: html, bom } = readText(abs);
    const stem = file.replace(/\.html$/i, "");
    const bytes = Buffer.byteLength(html) + (bom ? 3 : 0);
    const rec = { file, abs, rel: "apps/" + file, stem, bom, bytes, html };
    const blk = findMetaBlock(html);
    if (!blk) {
      rec.meta = null;
      problems.push("apps/" + file + ":1: ERROR missing <script type=\"" + META_TYPE + "\"> metadata block after <title>");
      broken.push(rec);
      continue;
    }
    rec.metaLine = blk.line;
    let parsed = null;
    try {
      parsed = JSON.parse(blk.body);
    } catch (err) {
      problems.push("apps/" + file + ":" + blk.line + ": ERROR metadata block is not valid JSON: " + String(err.message).split("\n")[0]);
      broken.push(rec);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push("apps/" + file + ":" + blk.line + ": ERROR metadata block must be a JSON object");
      broken.push(rec);
      continue;
    }
    rec.meta = parsed;
    rec.views = buildViews(html);
    apps.push(normalizeApp(rec));
  }
  return { apps, broken, problems };
}

function normalizeApp(rec) {
  const m = rec.meta;
  const a = { ...rec, id: m.id, name: m.name, cat: m.cat, desc: m.desc, icon: m.icon, w: m.w, h: m.h };
  a.entry = typeof ID_RE.test(String(m.id || "")) ? entryFor(m.id) : entryFor(rec.stem);
  return a;
}

/* =========================================================================
 * 7. index generation (shared by --write and --check drift detection)
 * ======================================================================= */

function categoryFiles(apps) {
  const sorted = [...apps].sort(byNameThenId);
  const cats = [];
  for (const cat of CATEGORIES) {
    const list = sorted.filter((a) => a.cat === cat);
    if (!list.length) continue;
    cats.push({ cat, slug: slugOf(cat), file: "apps/index/" + slugOf(cat) + ".json", count: list.length });
  }
  return { sorted, cats, byCat: cats.map((c) => ({ ...c, apps: sorted.filter((a) => a.cat === c.cat) })) };
}

function indexPayload(cat, list) {
  return {
    schema: SCHEMA_APPS,
    cat,
    apps: list.map((a) => {
      const o = { id: a.id, name: a.name, cat: a.cat, desc: a.desc };
      if (a.icon) o.icon = a.icon;
      o.entry = entryFor(a.id);
      if (a.w !== undefined) o.w = a.w;
      if (a.h !== undefined) o.h = a.h;
      return o;
    }),
  };
}

function manifestPayload(apps) {
  const { sorted } = categoryFiles(apps);
  const ordered = [];
  for (const cat of CATEGORIES) for (const a of sorted.filter((x) => x.cat === cat)) ordered.push(a);
  return {
    schema: SCHEMA_APPS,
    apps: ordered.map((a) => {
      const o = { id: a.id, name: a.name, cat: a.cat, desc: a.desc };
      if (a.icon) o.icon = a.icon;
      o.entry = entryFor(a.id);
      if (a.w !== undefined) o.w = a.w;
      if (a.h !== undefined) o.h = a.h;
      o.preload = false;
      return o;
    }),
  };
}

function categoriesPayload(apps) {
  const { cats } = categoryFiles(apps);
  return { schema: SCHEMA_CATS, categories: cats.map(({ cat, slug, file, count }) => ({ cat, slug, file, count })) };
}

const json2 = (o) => JSON.stringify(o, null, 2) + "\n";

/* =========================================================================
 * 8. mode: --add-meta
 * ======================================================================= */

function modeAddMeta() {
  const man = readJson(MANIFEST_FILE);
  const list = Array.isArray(man.apps) ? man.apps : [];
  const byEntry = new Map();
  for (const a of list) if (a && typeof a.entry === "string") byEntry.set(a.entry.replace(/\\/g, "/"), a);

  const added = [];
  const already = [];
  const skipped = [];
  const errors = [];

  for (const file of appFiles()) {
    const abs = path.join(APPS_DIR, file);
    const { text: html, bom } = readText(abs);
    if (findMetaBlock(html)) {
      already.push(file);
      continue;
    }
    /* Never touch a file this manifest does not know about: new tools are being written by
       other agents right now and only their author may edit them. */
    const m = byEntry.get("apps/" + file);
    if (!m) {
      skipped.push(file);
      continue;
    }
    const entry = {
      id: m.id,
      name: m.name,
      cat: m.cat,
      desc: m.desc,
      icon: m.icon,
      w: m.w,
      h: m.h,
    };
    const titleRe = /<title\b[^>]*>[\s\S]*?<\/title>/i;
    const t = titleRe.exec(html);
    if (!t) {
      errors.push("apps/" + file + ": no <title> element — cannot place the block after it");
      continue;
    }
    let insertAt = t.index + t[0].length;
    if (html[insertAt] === "\n") insertAt += 1;
    const block = metaBlock(entry) + "\n";
    writeText(abs, html.slice(0, insertAt) + block + html.slice(insertAt), bom);
    added.push(file);
  }

  console.log("add-meta: " + added.length + " block(s) inserted, " + already.length + " already had one.");
  for (const f of added) console.log("  inserted  apps/" + f);
  for (const f of already) console.log("  untouched apps/" + f + " (metadata block present)");
  if (skipped.length) {
    console.log("  REFUSED " + skipped.length + " file(s) not listed in apps/manifest.json (left exactly as found):");
    for (const f of skipped) console.log("    refused apps/" + f);
  }
  for (const e of errors) console.log("  ERROR " + e);
  if (errors.length) process.exitCode = 1;
}

/* =========================================================================
 * 9. mode: --write
 * ======================================================================= */

function modeWrite() {
  const { apps, problems } = scanApps();
  if (problems.length) {
    console.log("write: refused — every app needs a valid metadata block first.");
    for (const p of problems) console.log("  " + p);
    console.log("Fix the files above (new apps must embed their own block; see apps/CATALOG.md), then re-run --write.");
    process.exitCode = 1;
    return;
  }
  const badCat = apps.filter((a) => CATEGORIES.indexOf(a.cat) < 0);
  if (badCat.length) {
    console.log("write: refused — unknown category value:");
    for (const a of badCat) console.log("  " + a.rel + ":" + a.metaLine + ": ERROR cat \"" + a.cat + "\" is not a CATALOG.md category");
    process.exitCode = 1;
    return;
  }

  const groups = categoryFiles(apps).byCat;
  fs.mkdirSync(INDEX_DIR, { recursive: true });

  const written = [];
  const cats = categoriesPayload(apps);
  writeText(CATEGORIES_PATH, json2(cats), false);
  written.push(rel(CATEGORIES_PATH));

  const keep = new Set();
  for (const g of groups) {
    const target = path.join(INDEX_DIR, g.slug + ".json");
    writeText(target, json2(indexPayload(g.cat, g.apps)), false);
    keep.add(path.basename(target));
    written.push(rel(target) + " (" + g.count + ")");
  }
  writeText(MANIFEST_FILE, json2(manifestPayload(apps)), false);
  written.push(rel(MANIFEST_FILE) + " (" + apps.length + ")");

  /* Drop category files that no longer have any app — apps/index/ is generated, not authored. */
  const stale = [];
  for (const f of fs.readdirSync(INDEX_DIR)) {
    if (!/\.json$/.test(f) || f === "categories.json" || keep.has(f)) continue;
    fs.rmSync(path.join(INDEX_DIR, f));
    stale.push(f);
  }

  console.log("write: generated " + written.length + " file(s) from " + apps.length + " app(s).");
  for (const w of written) console.log("  " + w);
  if (stale.length) console.log("  removed stale: " + stale.join(", "));
}

/* =========================================================================
 * 10. mode: --check
 * ======================================================================= */

const NETWORK_CHECKS = [
  ["fetch(", /\bfetch\s*\(/g],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/g],
  ["WebSocket(", /\bWebSocket\s*\(/g],
  ["EventSource(", /\bEventSource\s*\(/g],
  ["import(", /\bimport\s*\(/g],
  ["importScripts(", /\bimportScripts\s*\(/g],
  ["sendBeacon", /\bsendBeacon\b/g],
];
const REMOTE_ASSET_CHECKS = [
  ["@font-face", /@font-face/g],
  ["url(http", /url\(\s*["']?\s*(?:https?:)?\/\//gi],
  ["@import", /@import\s+["'(]/gi],
];
const EXEC_CHECKS = [
  ["eval(", /(?:^|[^\w$.])eval\s*\(/g],
  ["new Function(", /new\s+Function\s*\(/g],
];
const RESOURCE_TAGS = /^(script|link|img|image|iframe|frame|source|audio|video|object|embed|use)$/i;
/** XML/SVG/MathML namespace URIs are identifiers, never fetched — must not read as network. */
const NAMESPACE_ALLOW = /^https?:\/\/(?:www\.w3\.org|purl\.org|schema\.org|ns\.adobe\.com|xml\.sourceforge\.net)\b/i;

function findMatches(text, re) {
  const hits = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    hits.push({ index: m.index, token: m[0].trim() });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return hits;
}

/**
 * Resource-loading tags that point outside the file. A single-file app may not reference
 * another local file either, so anything that is not a fragment/data/blob/namespace URI fails.
 * `<a href>`/`<form action>` are navigation, not resource loads, and are deliberately ignored.
 */
function externalTags(markup) {
  const out = [];
  const re = /<([a-zA-Z][\w:-]*)\b[^>]*?\b(src|href|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  let m;
  while ((m = re.exec(markup))) {
    const tag = m[1];
    const url = m[4] ?? m[5] ?? m[6] ?? "";
    if (!RESOURCE_TAGS.test(tag)) continue;
    if (url === "" || /^(data:|blob:|about:blank|#)/i.test(url)) continue;    if (NAMESPACE_ALLOW.test(url)) continue;
    out.push({ index: m.index, url });
  }
  return out;
}

function titleText(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Find a top-level `function NAME(` / `NAME=function(` body via brace matching on masked code. */
function functionBody(code, name) {
  const re = new RegExp("function\\s+" + name.replace(/[^\w$]/g, "\\w") + "\\s*\\(", "g");
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf("{", m.index + m[0].length);
    if (open < 0) continue;
    let d = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") d++;
      else if (code[i] === "}") {
        d--;
        if (d === 0) return { body: code.slice(open, i + 1), start: open, end: i };
      }
    }
  }
  return null;
}

const ESCAPE_RE = /&lt;|&amp;|replace\(\s*\/[<&]/;
const ALLOWLIST_RE = /allow\s?list|white\s?list|allowed\s?tags|sanitiz/i;
const DOC_RE = /escap\w*|allow\s?list|white\s?list|sanitiz/i;

function innerHtmlAssignments(code) {
  const out = [];
  for (const re of [/\.innerHTML\s*=(?!=)/g, /\[\s*["']innerHTML["']\s*\]\s*=(?!=)/g]) {
    for (const h of findMatches(code, re)) out.push(h.index);
  }
  return out.sort((a, b) => a - b);
}

/**
 * An innerHTML write is accepted only when it is confined to a documented
 * escape-then-allowlist converter (the markdown-notes precedent):
 *   RHS must be converter(...)  AND
 *   the converter body must escape (&lt;/&amp;/replace(/</) AND mention an allowlist, AND
 *   a comment documenting that must sit at the assignment or at the converter.
 */
function classifyInnerHtml(html, code, at) {
  const rhs = code.slice(code.indexOf("=", at), code.indexOf("=", at) + 120);
  const m = /^\s*=\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rhs);
  if (!m) {
    if (/^\s*=\s*(["'])\1/.test(rhs)) return { level: "info", why: "assigns an empty/literal string" };
    return { level: "error", why: "assigns a non-converter value" };
  }
  const name = m[1];
  const fn = functionBody(code, name);
  if (!fn) return { level: "error", why: "converter " + name + "() not found in this file" };
  const body = fn.body;
  const escaped = ESCAPE_RE.test(body) || /escapeHtml\w*\(/.test(body);
  const allowlisted = ALLOWLIST_RE.test(body) || ALLOWLIST_RE.test(html.slice(Math.max(0, fn.start - 1800), fn.start));
  const docAtUse = DOC_RE.test(html.slice(Math.max(0, html.lastIndexOf("\n", at) - 400), at));
  const docAtFn = DOC_RE.test(html.slice(Math.max(0, fn.start - 1800), fn.start));
  if (escaped && allowlisted && (docAtUse || docAtFn)) {
    return { level: "info", why: "escaped+allowlisted converter " + name + "(), documented" };
  }
  return { level: "error", why: "converter " + name + "() is not a documented escape-then-allowlist path" };
}

function checkApp(app, report) {
  const R = (line, level, msg) => report.push(app.rel + ":" + line + ": " + level + " " + msg);

  /* --- metadata contract --- */
  const m = app.meta;
  const id = m.id;
  if (typeof id !== "string" || !id) R(app.metaLine, "ERROR", "metadata: missing id");
  else {
    if (!ID_RE.test(id)) R(app.metaLine, "ERROR", "metadata id \"" + id + "\" is not lowercase kebab-case");
    if (id !== app.stem) R(app.metaLine, "ERROR", "metadata id \"" + id + "\" != filename stem \"" + app.stem + "\" (entry must be " + entryFor(app.stem) + ")");
  }
  if (typeof m.name !== "string" || !m.name.trim()) R(app.metaLine, "ERROR", "metadata: missing name");
  if (typeof m.desc !== "string" || !m.desc.trim()) R(app.metaLine, "ERROR", "metadata: missing desc");
  if (CATEGORIES.indexOf(m.cat) < 0) R(app.metaLine, "ERROR", "metadata cat \"" + m.cat + "\" is not one of the CATALOG.md categories");
  if (m.icon !== undefined && (typeof m.icon !== "string" || !m.icon)) R(app.metaLine, "ERROR", "metadata icon must be a non-empty string when present");
  for (const k of ["w", "h"]) {
    if (m[k] !== undefined && !(Number.isFinite(m[k]) && m[k] > 0 && m[k] < 8000)) R(app.metaLine, "ERROR", "metadata " + k + " must be a positive pixel number");
  }
  const keys = Object.keys(m);
  for (const k of keys) if (FIELD_ORDER.indexOf(k) < 0) R(app.metaLine, "INFO", "metadata field \"" + k + "\" is not part of the contract");

  /* --- self-title rule (CATALOG.md 8) --- */
  const title = titleText(app.html);
  if (title === null) R(1, "ERROR", "no <title> element");
  else if (typeof m.name === "string" && title !== m.name) R(1, "ERROR", "<title> \"" + title + "\" != metadata name \"" + m.name + "\"");

  /* --- size rule (CATALOG.md 9) --- */
  if (app.bytes > MAX_APP_BYTES) R(1, "ERROR", "file is " + app.bytes + " bytes, over the " + MAX_APP_BYTES + " byte limit");

  const code = app.views.code;
  const markup = app.views.markup;

  /* --- inline scripts must parse --- */
  const label = app.rel + "#script";
  let n = 0;
  /* Extracted from the comment-masked view: an HTML comment that merely mentions "<script>"
     must not desync span pairing. Masking preserves newlines, so line numbers still map. */
  for (const s of inlineScripts(app.views.code)) {
    n++;
    const err = syntaxErrorOf(s.code, label + n);
    if (err) R(s.line + err.lineOffset, "ERROR", "inline <script> does not parse (node:vm): " + err.message);
  }

  /* --- no outbound network APIs / remote assets ---
     Scanned on the comment-masked view (FAIL). The same patterns are also scanned on the raw
     text and anything that only survives there is reported as INFO, so a masking bug can never
     silently hide a violation. */
  const scanGroup = (patterns, text, raw, levelTag) => {
    for (const [token, re] of patterns) {
      const hitIdx = new Set(findMatches(text, re).map((h) => h.index));
      for (const h of hitIdx) R(lineAt(app.html, h), levelTag, "outbound network API \"" + token + "\": " + lineText(app.html, h));
      for (const h of findMatches(raw, re)) if (!hitIdx.has(h.index)) R(lineAt(app.html, h.index), "INFO", "\"" + token + "\" appears only inside a comment: " + lineText(app.html, h.index));
    }
  };
  scanGroup(NETWORK_CHECKS, code, app.html, "ERROR");
  scanGroup(REMOTE_ASSET_CHECKS, code, app.html, "ERROR");
  scanGroup(EXEC_CHECKS, code, app.html, "ERROR");

  for (const e of externalTags(markup)) R(lineAt(app.html, e.index), "ERROR", "external/other-file resource reference \"" + e.url.slice(0, 80) + "\": " + lineText(app.html, e.index));
  for (const h of findMatches(markup, /<script\b[^>]*\bsrc\s*=/gi)) R(lineAt(app.html, h.index), "ERROR", "external <script src=>: " + lineText(app.html, h.index));
  for (const h of findMatches(markup, /<link\b[^>]*\bhref\s*=/gi)) {
    const tagMatch = /<link\b[^>]*>/i.exec(markup.slice(h.index, h.index + 400));
    const href = tagMatch ? attrValue(tagMatch[0], "href") || "" : "";
    if (NAMESPACE_ALLOW.test(href) || /^(data:|blob:|#)/i.test(href)) continue;
    R(lineAt(app.html, h.index), "ERROR", "<link> with external href \"" + href.slice(0, 80) + "\": " + lineText(app.html, h.index));
  }

  /* --- innerHTML: INFO with the line; ERROR unless it is the documented converter --- */
  for (const at of innerHtmlAssignments(code)) {
    const line = lineAt(app.html, at);
    const v = classifyInnerHtml(app.html, code, at);
    if (v.level === "error") R(line, "ERROR", ".innerHTML= assignment is not confined to a documented escape-then-allowlist converter (" + v.why + ") — accepted precedent: " + INNERHTML_PRECEDENT + " | " + lineText(app.html, at));
    else R(line, "INFO", ".innerHTML= assignment accepted (" + v.why + "): " + lineText(app.html, at));
  }
}

function modeCheck() {
  const report = [];
  const { apps, broken, problems } = scanApps();
  report.push(...problems);

  /* --- duplicate ids across app files --- */
  const seen = new Map();
  for (const a of apps) {
    const key = String(a.meta.id);
    if (seen.has(key)) report.push(a.rel + ":" + a.metaLine + ": ERROR duplicate id \"" + key + "\" also declared in " + seen.get(key).rel);
    else seen.set(key, a);
  }

  for (const a of apps) checkApp(a, report);

  /* --- generated artefacts must exist and match a fresh generation (drift) --- */
  if (!broken.length) {
    const expected = new Map();
    expected.set(rel(CATEGORIES_PATH), json2(categoriesPayload(apps)));
    for (const g of categoryFiles(apps).byCat) expected.set("apps/index/" + g.slug + ".json", json2(indexPayload(g.cat, g.apps)));
    expected.set(rel(MANIFEST_FILE), json2(manifestPayload(apps)));
    for (const [p, body] of expected) {
      const abs = path.join(ROOT, p);
      if (!fs.existsSync(abs)) {
        report.push(p + ":1: ERROR missing generated file — run: node tools/nucleus-catalogue.mjs --write");
        continue;
      }
      if (readText(abs).text !== body) report.push(p + ":1: ERROR is stale/drifted — run: node tools/nucleus-catalogue.mjs --write");
    }
    /* extra index files = an app was renamed/removed without regenerating */
    if (fs.existsSync(INDEX_DIR)) {
      for (const f of fs.readdirSync(INDEX_DIR).sort()) {
        if (!/\.json$/.test(f) || f === "categories.json") continue;
        if (!expected.has("apps/index/" + f)) report.push("apps/index/" + f + ":1: ERROR not produced by --write (stale category file)");
      }
    }
  }

  /* --- cross-index identity: every app listed, every listing an app --- */
  const appIds = new Set(apps.map((a) => String(a.meta.id)));
  const indexed = new Map(); /* id -> Set(file) */
  if (fs.existsSync(INDEX_DIR)) {
    for (const f of fs.readdirSync(INDEX_DIR).sort()) {
      if (!/\.json$/.test(f) || f === "categories.json") continue;
      let j = null;
      try {
        j = readJson(path.join(INDEX_DIR, f));
      } catch (err) {
        report.push("apps/index/" + f + ":1: ERROR not valid JSON: " + String(err.message).split("\n")[0]);
        continue;
      }
      const list = j && Array.isArray(j.apps) ? j.apps : [];
      if (!list.length && j && !Array.isArray(j.apps)) report.push("apps/index/" + f + ":1: ERROR missing apps array");
      for (const e of list) {
        const id = e && e.id;
        if (typeof id !== "string") {
          report.push("apps/index/" + f + ":1: ERROR entry without id");
          continue;
        }
        if (!indexed.has(id)) indexed.set(id, new Set());
        indexed.get(id).add("apps/index/" + f);
        if (e.entry !== entryFor(id)) report.push("apps/index/" + f + ":1: ERROR " + id + " entry must be " + entryFor(id) + " (got " + e.entry + ")");
        if (!appIds.has(id)) report.push("apps/index/" + f + ":1: ERROR lists " + id + " but apps/" + id + ".html has no such app (drift — re-run --write)");
      }
    }
    for (const [id, files] of [...indexed].sort()) {
      if (files.size > 1) report.push("apps/index/categories.json:1: ERROR id \"" + id + "\" appears in multiple index files: " + [...files].sort().join(", "));
    }
    for (const a of apps) if (!indexed.has(String(a.meta.id))) report.push("apps/index/categories.json:1: ERROR " + a.rel + " is missing from the generated indexes — run --write");
  } else {
    report.push("apps/index/categories.json:1: ERROR apps/index/ does not exist — run: node tools/nucleus-catalogue.mjs --write");
  }

  /* --- categories.json sanity --- */
  if (fs.existsSync(CATEGORIES_PATH)) {
    let c = null;
    try {
      c = readJson(CATEGORIES_PATH);
    } catch (err) {
      report.push("apps/index/categories.json:1: ERROR not valid JSON: " + String(err.message).split("\n")[0]);
    }
    if (c) {
      for (const g of Array.isArray(c.categories) ? c.categories : []) {
        if (CATEGORIES.indexOf(g.cat) < 0) report.push("apps/index/categories.json:1: ERROR unknown category \"" + g.cat + "\"");
        if (g.slug !== slugOf(g.cat)) report.push("apps/index/categories.json:1: ERROR category \"" + g.cat + "\" slug should be " + g.slug);
        if (g.file !== "apps/index/" + g.slug + ".json") report.push("apps/index/categories.json:1: ERROR category \"" + g.cat + "\" file should be apps/index/" + g.slug + ".json");
        if (!fs.existsSync(path.join(ROOT, g.file))) report.push(g.file + ":1: ERROR referenced by categories.json but missing");
      }
    }
  }

  /* --- manifest sanity (it is a generated artifact, but the shell still reads it) --- */
  if (fs.existsSync(MANIFEST_FILE)) {
    let man = null;
    try {
      man = readJson(MANIFEST_FILE);
    } catch (err) {
      report.push("apps/manifest.json:1: ERROR not valid JSON: " + String(err.message).split("\n")[0]);
    }
    if (man) {
      const ids = new Set();
      for (const e of Array.isArray(man.apps) ? man.apps : []) {
        if (!e || typeof e.id !== "string") {
          report.push("apps/manifest.json:1: ERROR entry without id");
          continue;
        }
        if (ids.has(e.id)) report.push("apps/manifest.json:1: ERROR duplicate id \"" + e.id + "\"");
        ids.add(e.id);
        if (e.entry !== entryFor(e.id)) report.push("apps/manifest.json:1: ERROR " + e.id + " entry must be " + entryFor(e.id));
        if (!appIds.has(e.id)) report.push("apps/manifest.json:1: ERROR lists " + e.id + " which is not in apps/ (drift — re-run --write)");
        if (e.preload !== false) report.push("apps/manifest.json:1: ERROR " + e.id + " preload must be false (lazy loading is the whole design)");
      }
      for (const a of apps) if (!ids.has(String(a.meta.id))) report.push("apps/manifest.json:1: ERROR " + a.rel + " missing from the manifest — run --write");
    }
  }

  const lines = report.sort();
  const errors = lines.filter((l) => l.indexOf(": ERROR ") >= 0);
  const infos = lines.filter((l) => l.indexOf(": INFO ") >= 0);
  for (const l of lines) console.log(l);
  console.log("");
  console.log("check: " + apps.length + " app file(s) scanned" + (broken.length ? ", " + broken.length + " unreadable" : "") + ".");
  console.log("check: " + errors.length + " ERROR, " + infos.length + " INFO.");
  if (errors.length) {
    console.log("check: FAILED");
    process.exitCode = 1;
  } else {
    console.log("check: PASSED" + (infos.length ? " (INFO items are advisory)" : ""));
  }
}

/* =========================================================================
 * 11. mode: --stats
 * ======================================================================= */

function modeStats() {
  const { apps, broken } = scanApps();
  const rows = apps.slice().sort(byNameThenId);
  const total = rows.reduce((s, a) => s + a.bytes, 0);
  const largest = rows.reduce((b, a) => (a.bytes > (b ? b.bytes : 0) ? a : b), null);
  const manifestBytes = fs.existsSync(MANIFEST_FILE) ? fs.statSync(MANIFEST_FILE).size : 0;
  const catsBytes = fs.existsSync(CATEGORIES_PATH) ? fs.statSync(CATEGORIES_PATH).size : 0;
  const indexFiles = fs.existsSync(INDEX_DIR) ? fs.readdirSync(INDEX_DIR).filter((f) => /\.json$/.test(f) && f !== "categories.json").sort() : [];
  const perCatBytes = indexFiles.map((f) => [f, fs.statSync(path.join(INDEX_DIR, f)).size]);

  /* Projected shell-metadata cost: what the shell pays just to *know* about the catalogue.
     The shell never pays for tool code at boot — only this metadata, and only lazily. */
  const entryJson = (a) => metaJson({ id: a.id, name: a.name, cat: a.cat, desc: a.desc, icon: a.icon, w: a.w, h: a.h });
  const entryBytes = rows.map((a) => Buffer.byteLength(entryJson(a)));
  const avgEntry = entryBytes.length ? Math.round(entryBytes.reduce((s, x) => s + x, 0) / entryBytes.length) : 0;
  const catBytes = Buffer.byteLength(json2(categoriesPayload(apps)));
  const liveCats = new Set(rows.map((a) => a.cat)).size || 1;
  const perCatAvg = perCatBytes.length ? Math.round(perCatBytes.reduce((s, [, b]) => s + b, 0) / perCatBytes.length) : 0;

  console.log("nucleus catalogue stats — " + rows.length + " app(s)" + (broken.length ? " (+" + broken.length + " unreadable)" : ""));
  console.log("");
  console.log("category                    apps    bytes     avg");
  for (const cat of CATEGORIES) {
    const list = rows.filter((a) => a.cat === cat);
    if (!list.length) continue;
    const b = list.reduce((s, a) => s + a.bytes, 0);
    console.log(pad(cat, 27) + String(list.length).padStart(5) + String(b).padStart(9) + String(Math.round(b / list.length)).padStart(8));
  }
  for (const b of broken) console.log(pad(String(b.cat || "(unreadable)"), 27) + "    -        -       -  " + b.rel);
  console.log("");
  console.log("total bytes          " + total);
  console.log("average app          " + (rows.length ? Math.round(total / rows.length) : 0) + " bytes");
  console.log("largest app          " + (largest ? largest.rel + " (" + largest.bytes + " bytes, " + Math.round((largest.bytes / MAX_APP_BYTES) * 100) + "% of the " + MAX_APP_BYTES + " byte budget)" : "-"));
  console.log("");
  console.log("shell-metadata cost of the current catalogue");
  console.log("  categories.json      " + catBytes + " bytes   (one small fetch when the Store opens)");
  console.log("  one category index   ~" + perCatAvg + " bytes   (only the category being viewed is fetched)");
  console.log("  all indexes          " + (catsBytesTotal() + catBytes) + " bytes if every category were opened");
  console.log("  manifest.json        " + manifestBytes + " bytes   (http(s) only, fetched once after boot)");
  console.log("  one app entry        ~" + avgEntry + " bytes of metadata");
  console.log("  all " + rows.length + " entries inline: " + rows.length * avgEntry + " bytes (" + kb(rows.length * avgEntry) + ")");
  console.log("");
  console.log("scaling trend at ~" + avgEntry + " bytes/app and ~" + liveCats + " live categories (tool code is never counted):");
  for (const n of [rows.length, 40, 100, 200, 400]) {
    const inline = n * avgEntry;
    const catsFile = catBytes + Math.max(0, n - rows.length) * 24;
    const oneCat = Math.round((n * avgEntry) / liveCats);
    console.log(
      "  " +
        String(n).padStart(4) +
        " apps: inline ~" + kb(inline) + ", categories.json ~" + kb(catsFile) + ", per-category fetch ~" + kb(oneCat) + " (" + oneCat + " bytes)"
    );
  }
}

/** Sum of the generated per-category index files, for the "open everything" figure. */
function catsBytesTotal() {
  if (!fs.existsSync(INDEX_DIR)) return 0;
  return fs
    .readdirSync(INDEX_DIR)
    .filter((f) => /\.json$/.test(f) && f !== "categories.json")
    .reduce((s, f) => s + fs.statSync(path.join(INDEX_DIR, f)).size, 0);
}

function kb(n) {
  return (n / 1024).toFixed(1) + " KB";
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s + " " : s + " ".repeat(n - s.length);
}

/* =========================================================================
 * 12. CLI
 * ======================================================================= */

const HELP = `nucleus-catalogue — generate and verify the apps/ catalogue (dev-time only)

  node tools/nucleus-catalogue.mjs --add-meta
      Insert the <script type="${META_TYPE}"> block right after <title> in every
      apps/*.html that lacks one, taking id/name/cat/desc/icon/w/h from apps/manifest.json
      (matched on the entry path). Files are otherwise byte-for-byte unchanged.
      Files not listed in apps/manifest.json are REFUSED and left alone, so in-flight
      tools written by other agents are never touched. _template.html is always skipped.

  node tools/nucleus-catalogue.mjs --write
      Scan apps/*.html, parse every metadata block and regenerate
      apps/index/categories.json, apps/index/<category-slug>.json and apps/manifest.json
      from that single source of truth. Refuses to write if any block is missing/invalid.
      Deterministic: apps sorted by name, categories in CATALOG.md order, no timestamps.

  node tools/nucleus-catalogue.mjs --check
      Compliance gate; exits 1 and prints "apps/<file>:<line>: ERROR <what>".
      Covers: metadata block present/valid, id == filename stem, name == <title>,
      cat in CATALOG.md, unique ids, every inline <script> parses under node:vm,
      no fetch/XHR/WebSocket/EventSource/import()/importScripts/sendBeacon,
      no external <script src=>/<link href>/img/iframe, no @font-face, no @import,
      no url(http...), no eval()/new Function(), .innerHTML= reported as INFO and
      failed unless confined to a documented escape-then-allowlist converter
      (${INNERHTML_PRECEDENT} is the accepted precedent), size <= ${MAX_APP_BYTES} bytes,
      and no drift between apps/, apps/index/* and apps/manifest.json.
      The XML namespace http://www.w3.org/2000/svg is an identifier, not a URL, and
      is never reported.

  node tools/nucleus-catalogue.mjs --stats
      Per-category counts, byte totals, average/largest app, and the projected
      shell-metadata cost of the catalogue (so the scaling trend stays visible).
`;

const MODES = { "--add-meta": modeAddMeta, "--write": modeWrite, "--check": modeCheck, "--stats": modeStats };

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h" || arg === "help") {
  console.log(HELP);
  if (!arg) process.exitCode = 1;
} else if (!MODES[arg]) {
  console.error("unknown mode: " + arg);
  console.log(HELP);
  process.exitCode = 2;
} else {
  MODES[arg]();
}
