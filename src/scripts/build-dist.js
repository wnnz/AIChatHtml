const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const tailwindCli = path.join(rootDir, "node_modules", "tailwindcss", "lib", "cli.js");

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(path.join(distDir, "css"), { recursive: true });

fs.copyFileSync(path.join(rootDir, "index.html"), path.join(distDir, "index.html"));
fs.copyFileSync(path.join(rootDir, "login.html"), path.join(distDir, "login.html"));
fs.cpSync(path.join(rootDir, "js"), path.join(distDir, "js"), { recursive: true });

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
