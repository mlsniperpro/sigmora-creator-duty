#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/scan-release.mjs";
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".gcloud",
  ".pnpm-store",
  "coverage",
  "data",
  "dist",
  "node_modules",
]);
const SKIPPED_FILES = new Set(["LICENSE", "package-lock.json"]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const ALLOWED_MODEL_IDS = new Set([
  "gemini-3.7-flash",
  "veo-3.1-generate-preview",
  "lyria-3-clip-preview",
]);

const SECRET_PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/g],
  ["Google service-account private key", /-----BEGIN PRIVATE KEY-----/g],
  ["AWS access key", /AKIA[0-9A-Z]{16}/g],
  ["GitHub token", /gh[oprsu]_[0-9A-Za-z]{30,}/g],
  ["Slack token", /xox[baprs]-[0-9A-Za-z-]{20,}/g],
  ["live secret key", /sk_live_[0-9A-Za-z_-]{20,}/g],
  [
    "assigned application credential",
    /(?:GEMINI_API_KEY|DEMO_API_KEY|SIGMORA_API_TOKEN)[ \t]*=[ \t]*[0-9A-Za-z_./+=-]{20,}/g,
  ],
];

const PLACEHOLDER_PATTERNS = [
  ["unfinished marker", /\b(?:TO[D]O|TB[D]|FIXM[E])\b/g],
  ["replacement marker", /\b(?:REPLACE[_ -]?ME|CHANGE[_ -]?ME)\b/gi],
  ["generic project placeholder", /\bYOUR[_ -](?:PROJECT|SERVICE|BUCKET|KEY)\b/gi],
  [
    "submission placeholder",
    /\[(?:PUBLIC_[A-Z0-9_]+|EXACT_[A-Z0-9_]+|MEASURED_[A-Z0-9_]+|[A-Z0-9_]+_URL|PROJECT_ID)\]/g,
  ],
  ["angle-bracket placeholder", /<(?:PROJECT|SERVICE|BUCKET|MODEL|REPOSITORY|VIDEO|DEVPOST)_[A-Z0-9_]+>/g],
];

const failures = [];
const files = await releaseFiles();

for (const relativePath of files) {
  if (isSensitiveFileName(relativePath)) {
    failures.push(`${relativePath} is a credential-bearing file type and must not be released.`);
  }
  if (SKIPPED_FILES.has(relativePath) || !isTextFile(relativePath)) continue;
  const absolutePath = path.join(ROOT, relativePath);
  const metadata = await stat(absolutePath);
  if (!metadata.isFile() || metadata.size > 2_000_000) continue;
  const content = await readFile(absolutePath, "utf8");

  if (relativePath !== SELF) {
    scanPatterns(relativePath, content, SECRET_PATTERNS);
    scanPatterns(relativePath, content, PLACEHOLDER_PATTERNS);
  }
  // Tests intentionally contain ineligible and mocked resolved IDs to prove
  // rejection/evidence behavior. Release-facing source and copy remain locked.
  if (!relativePath.startsWith("tests/")) scanModels(relativePath, content);
}

await assertReleaseLock();

if (failures.length > 0) {
  console.error("Release scan failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Release scan passed (${files.length} repository files inspected).`);
}

function scanPatterns(relativePath, content, patterns) {
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      failures.push(`${relativePath}:${lineNumber(content, match.index ?? 0)} contains ${label}.`);
    }
  }
}

function scanModels(relativePath, content) {
  const pattern = /\b(?:gemini|veo|lyria|gemma)-[0-9][a-z0-9.-]*\b/gi;
  for (const match of content.matchAll(pattern)) {
    const model = match[0].toLowerCase();
    if (!ALLOWED_MODEL_IDS.has(model)) {
      failures.push(
        `${relativePath}:${lineNumber(content, match.index ?? 0)} names unreviewed model ID '${match[0]}'.`,
      );
    }
  }
}

async function assertReleaseLock() {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  if (packageJson.dependencies?.["@google/genai"] !== "2.19.0") {
    failures.push("package.json must pin @google/genai to reviewed version 2.19.0.");
  }

  const environment = await readFile(path.join(ROOT, ".env.example"), "utf8");
  requireLine(environment, "GEMINI_MODEL=gemini-3.7-flash", ".env.example");
  requireLine(environment, "ENABLE_VEO=false", ".env.example");
  requireLine(environment, "ENABLE_LYRIA=false", ".env.example");
  requireLine(environment, "ENABLE_GEMMA=false", ".env.example");

  const config = await readFile(path.join(ROOT, "src/config.ts"), "utf8");
  if (!config.includes('GEMINI_MODEL: z.string().min(1).default("gemini-3.7-flash")')) {
    failures.push("src/config.ts primary model default drifted from gemini-3.7-flash.");
  }
}

function requireLine(content, expected, file) {
  if (!content.split(/\r?\n/).includes(expected)) {
    failures.push(`${file} must contain exact release lock '${expected}'.`);
  }
}

async function releaseFiles() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split("\0").filter(Boolean).sort();
  } catch {
    const discovered = [];
    await walk(ROOT, discovered);
    return discovered.sort();
  }
}

async function walk(directory, discovered) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, discovered);
    } else if (entry.isFile()) {
      discovered.push(path.relative(ROOT, absolutePath));
    }
  }
}

function isTextFile(relativePath) {
  return (
    path.basename(relativePath) === "Dockerfile" ||
    path.basename(relativePath) === ".env.example" ||
    TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
  );
}

function isSensitiveFileName(relativePath) {
  const baseName = path.basename(relativePath).toLowerCase();
  if (baseName === ".env.example") return false;
  return (
    baseName === ".env" ||
    baseName.startsWith(".env.") ||
    /(?:credential|service-account).*\.json$/i.test(baseName) ||
    /\.(?:key|p12|pem)$/i.test(baseName)
  );
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}
