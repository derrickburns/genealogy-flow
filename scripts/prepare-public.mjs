import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

function commitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

mkdirSync("public", { recursive: true });
const html = readFileSync("index.html", "utf8").replaceAll("__COMMIT_SHA__", commitSha());
writeFileSync("public/index.html", html);
