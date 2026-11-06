import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = process.argv[2];
if (!packagePath) throw new Error("Pass the path to an npm-packed astro-buffer tarball.");
const astroVersion = process.env.ASTRO_VERSION ?? "7.4.5";
const root = await mkdtemp(join(tmpdir(), "astro-buffer-compatibility-"));
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args, env = {}) =>
  execFileSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "pipe",
    encoding: "utf8",
    timeout: 180_000,
  });

try {
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    `astro@${astroVersion}`,
    resolve(repository, packagePath),
  ]);
  await mkdir(join(root, "src/pages"), { recursive: true });
  await mkdir(join(root, "src/content/blog"), { recursive: true });
  await writeFile(join(root, "src/pages/index.astro"), "<h1>Compatibility fixture</h1>");
  await writeFile(
    join(root, "astro.config.mjs"),
    `import { defineConfig } from "astro/config";
import buffer from "astro-buffer";
export default defineConfig({
  site: "https://example.com",
  integrations: [buffer({
    posts: new URL("./src/buffer-posts.ts", import.meta.url),
    contentDirectory: "src/content/blog",
    channelIds: ["channel-one"],
    mode: "addToQueue",
  })],
});`,
  );
  await writeFile(
    join(root, "src/buffer-posts.ts"),
    `export const GET = () => Response.json([{
  filePath: "src/content/blog/new.md",
  title: "Compatibility article",
  url: "https://example.com/new/",
  text: "Custom compatibility announcement",
}]);`,
  );
  run("git", ["init", "--quiet"]);
  run("git", ["config", "user.name", "Compatibility test"]);
  run("git", ["config", "user.email", "test@example.com"]);
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n.astro/\nrequests.json\n");
  run("git", ["add", "."]);
  run("git", ["commit", "--quiet", "-m", "Existing site"]);
  const base = run("git", ["rev-parse", "HEAD"]).trim();
  await writeFile(join(root, "src/content/blog/new.md"), "New article\n");
  run("git", ["add", "."]);
  run("git", ["commit", "--quiet", "-m", "New article"]);
  await writeFile(
    join(root, "mock-fetch.mjs"),
    `import { writeFileSync } from "node:fs";
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, method: options?.method });
  writeFileSync("requests.json", JSON.stringify(requests));
  if (url === "https://example.com/new/" && options?.method === "HEAD") {
    return { ok: true, url };
  }
  if (url !== "https://api.buffer.com") throw new Error("Unexpected network request: " + url);
  const body = JSON.parse(options.body);
  requests[requests.length - 1].body = body;
  writeFileSync("requests.json", JSON.stringify(requests));
  if (body.query.includes("query Channels")) return Response.json({ data: { channels: [
    { id: "channel-one", name: "Selected", isDisconnected: false, isLocked: false },
    { id: "channel-two", name: "Excluded", isDisconnected: false, isLocked: false },
  ] } });
  if (body.query.includes("query Posts")) return Response.json({ data: { posts: {
    edges: [], pageInfo: { hasNextPage: false, endCursor: null },
  } } });
  if (body.query.includes("mutation Publish")) {
    return Response.json({ data: { createContentItem: { content: { id: "mock-content" } } } });
  }
  throw new Error("Unexpected Buffer query");
};`,
  );
  const env = {
    ASTRO_TELEMETRY_DISABLED: "1",
    BUFFER_API_KEY: "compatibility-placeholder",
    BUFFER_ORGANIZATION_ID: "compatibility-org",
    BUFFER_BASE_REF: base,
  };
  const build = (publishing, dryRun) => {
    try {
      return run(
        process.execPath,
        ["--import", "./mock-fetch.mjs", "./node_modules/astro/bin/astro.mjs", "build"],
        { ...env, BUFFER_PUBLISH: String(publishing), BUFFER_DRY_RUN: String(dryRun) },
      );
    } catch (error) {
      throw new Error(
        `Astro ${astroVersion} build failed:\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        { cause: error },
      );
    }
  };
  build(false, false);
  await assert.rejects(readFile(join(root, "requests.json")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "dist/buffer-posts.json")), { code: "ENOENT" });
  assert.match(await readFile(join(root, "dist/index.html"), "utf8"), /Compatibility fixture/);

  const output = build(true, true);
  assert.match(output, /Dry run:/);
  let requests = JSON.parse(await readFile(join(root, "requests.json"), "utf8"));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ body }) => !body.query.includes("mutation")));
  await assert.rejects(readFile(join(root, "dist/buffer-posts.json")), { code: "ENOENT" });

  build(true, false);
  requests = JSON.parse(await readFile(join(root, "requests.json"), "utf8"));
  const mutation = requests.find(({ body }) => body?.query.includes("mutation Publish"));
  assert.deepEqual(mutation.body.variables.input.posts, [
    {
      channelId: "channel-one",
      text: "Custom compatibility announcement\n\nhttps://example.com/new/",
      schedulingType: "automatic",
      mode: "addToQueue",
    },
  ]);
  assert.ok(requests.some(({ method }) => method === "HEAD"));
  await assert.rejects(readFile(join(root, "dist/buffer-posts.json")), { code: "ENOENT" });
  console.log(
    `Packaged integration works on Node ${process.version}, Astro ${astroVersion}: normal build, dry-run, mocked publishing.`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
