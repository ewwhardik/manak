/** Refresh generated API and measured documentation inventories after source changes. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_COMMANDS, PRODUCT } from "../src/api/commands/index.ts";
import { makeRegistry, openapiDocument } from "../src/api/index.ts";
import { VIEWS } from "../src/view/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const sources: { path: string; text: string }[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(ts|sql)$/.test(entry.name)) sources.push({ path: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") });
  }
}
walk(root);
const tests = sources.filter((s) => s.path.startsWith("tests/") && s.path.endsWith(".test.ts")).reduce((n, s) => n + [...s.text.matchAll(/^test\(/gm)].length, 0);
const ops = ALL_COMMANDS.length;
const gets = ALL_COMMANDS.filter((c) => c.method === "GET").length;
const posts = ops - gets;
const probes = ops * 6 * 2;
const pages = Object.keys(VIEWS).length;

for (const path of ["README.md", "docs/ARCHITECTURE.md", "docs/THREAT-MODEL.md"]) {
  let text = readFileSync(join(root, path), "utf8");
  text = text.replace(/(npm test +# )[\d,]+( tests)/g, `$1${tests}$2`)
    .replace(/The [\d,]+ tests are Node's own runner/, `The ${tests} tests are Node's own runner`)
    .replace(/(`npm test`, all )[\d,]+( of them)/g, `$1${tests}$2`)
    .replace(/\b\d+ operations\b/g, `${ops} operations`)
    .replace(/\b\d+ handlers\b/g, `${ops} handlers`)
    .replace(/\d+ × 6 × 2/g, `${ops} × 6 × 2`)
    .replace(/× 6 × 2 = (\*{0,2})\d+(\*{0,2})/g, `× 6 × 2 = $1${probes}$2`)
    .replace(/all \d+ requests\b/g, `all ${probes} requests`)
    .replace(/across all \d+\b/g, `across all ${probes}`)
    .replace(/\d+ are `GET`/g, `${gets} are \`GET\``)
    .replace(/\d+ are `POST`/g, `${posts} are \`POST\``)
    .replace(/\d+ have a hand-written page/g, `${pages} have a hand-written page`);
  text = text.replace(/^\| `([^`]+)` \| [\d,]+ \|/gm, (row, prefix: string) => {
    const n = sources.filter((s) => s.path !== "tests/source.test.ts" && (s.path === prefix || s.path.startsWith(`${prefix}/`))).reduce((n, s) => n + s.text.split("\n").length - 1, 0);
    return n ? `| \`${prefix}\` | ${n.toLocaleString("en-US")} |` : row;
  });
  writeFileSync(join(root, path), text, "utf8");
}
const doc = openapiDocument(makeRegistry(ALL_COMMANDS), {
  title: `${PRODUCT.title} — submission and judging`, version: PRODUCT.version,
  description: "Generated from the same command registry as the JSON API and browser forms.",
});
writeFileSync(join(root, "openapi.json"), JSON.stringify(doc, null, 2) + "\n", "utf8");
process.stdout.write(`Refreshed OpenAPI (${ALL_COMMANDS.length} operations) and documentation (${tests} tests).\n`);
