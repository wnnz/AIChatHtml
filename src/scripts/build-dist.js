const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { buildSync } = require("esbuild");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const tailwindCli = path.join(rootDir, "node_modules", "tailwindcss", "lib", "cli.js");
const appScriptTag = "  <script type=\"module\" src=\"./js/app.js\"></script>";
const highlightScriptTag = "  <script src=\"./js/highlight-runtime.js\"></script>";

function copyIndexHtml() {
  const indexHtmlPath = path.join(rootDir, "index.html");
  const indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
  const injectedHtml = indexHtml.includes(highlightScriptTag)
    ? indexHtml
    : indexHtml.replace(appScriptTag, `${highlightScriptTag}\n${appScriptTag}`);

  fs.writeFileSync(path.join(distDir, "index.html"), injectedHtml);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, "css"), { recursive: true });

copyIndexHtml();
fs.copyFileSync(path.join(rootDir, "login.html"), path.join(distDir, "login.html"));
fs.cpSync(path.join(rootDir, "js"), path.join(distDir, "js"), { recursive: true });

buildSync({
  entryPoints: [path.join(rootDir, "js", "highlight-runtime-entry.js")],
  outfile: path.join(distDir, "js", "highlight-runtime.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  logLevel: "silent"
});

execFileSync(process.execPath, [
  tailwindCli,
  "-i",
  path.join(rootDir, "css", "input.css"),
  "-o",
  path.join(distDir, "css", "styles.css"),
  "--minify"
], {
  cwd: rootDir,
  stdio: "inherit"
});

console.log("Built static files into dist/");
