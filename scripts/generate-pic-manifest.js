const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const picDir = path.join(rootDir, "pic");
const manifestPath = path.join(picDir, "manifest.json");
const allowedExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

if (!fs.existsSync(picDir)) {
  fs.mkdirSync(picDir, { recursive: true });
}

const files = fs
  .readdirSync(picDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => allowedExts.has(path.extname(name).toLowerCase()))
  .sort((a, b) => a.localeCompare(b));

fs.writeFileSync(manifestPath, `${JSON.stringify(files, null, 2)}\n`, "utf8");
console.log(`Generated ${path.relative(rootDir, manifestPath)} with ${files.length} file(s).`);
