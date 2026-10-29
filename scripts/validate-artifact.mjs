// Checks the single-file build (dist/server/index.js) used by the chatgpt.site preview host.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [source, manifest] = await Promise.all([
  readFile(resolve(projectRoot, "dist/server/index.js"), "utf8"),
  readFile(resolve(projectRoot, "dist/.openai/hosting.json"), "utf8"),
]);
JSON.parse(manifest);
// A data URL forces ESM parsing even though the generated output has no package.json.
const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
assert.deepEqual(Object.keys(worker), ["default"], "Workers accept only handler exports");
assert.equal(typeof worker.default.fetch, "function");
const home = await worker.default.fetch(new Request("https://preview.example/"), {});
assert.equal(home.status, 200);
assert.match(home.headers.get("Content-Type"), /text\/html/);
const status = await worker.default.fetch(new Request("https://preview.example/api/checkout/status"), {});
assert.equal((await status.json()).configured, false);
console.log("Artifact is valid ESM, exports only default.fetch and serves the storefront");
