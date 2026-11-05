import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import buffer from "../src/index.ts";

const article = {
  filePath: "src/content/blog/new.md",
  title: "New article",
  url: "https://example.com/new/",
};
const channels = [
  { id: "one", name: "First channel", isDisconnected: false, isLocked: false },
  { id: "two", name: "Second channel", isDisconnected: false, isLocked: false },
];

async function setup(
  t,
  { enabled = true, existing = [], failChannel, nextPage = [], availableChannels = channels } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "astro-buffer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    BUFFER_PUBLISH: enabled ? "true" : undefined,
    BUFFER_API_KEY: "test-token",
    BUFFER_ORGANIZATION_ID: "test-org",
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await mkdir(join(root, "src/content/blog"), { recursive: true });
  await writeFile(join(root, "src/content/blog/old.md"), "Existing article\n");
  await writeFile(join(root, "src/content/blog/rename.md"), "Article to rename\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Existing articles");
  const previousBase = process.env.BUFFER_BASE_REF;
  t.after(() => {
    if (previousBase === undefined) delete process.env.BUFFER_BASE_REF;
    else process.env.BUFFER_BASE_REF = previousBase;
  });
  process.env.BUFFER_BASE_REF = git("rev-parse", "HEAD");
  await writeFile(join(root, "src/content/blog/new.md"), "New article\n");
  await writeFile(join(root, "src/content/blog/old.md"), "Edited existing article\n");
  await rename(join(root, "src/content/blog/rename.md"), join(root, "src/content/blog/renamed.md"));
  git("add", ".");
  git("commit", "--quiet", "-m", "Publish new article");

  const dir = pathToFileURL(join(root, "dist/"));
  await mkdir(dir);
  const manifest = new URL("buffer-posts.json", dir);
  await writeFile(
    manifest,
    JSON.stringify([
      article,
      { ...article, filePath: "src/content/blog/old.md", url: "https://example.com/old/" },
      { ...article, filePath: "src/content/blog/renamed.md", url: "https://example.com/renamed/" },
    ]),
  );
  const requests = [];
  const created = [];
  const logs = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "https://api.buffer.com") {
      assert.equal(url, article.url);
      return { ok: true, url };
    }
    assert.equal(options.headers.Authorization, "Bearer test-token");
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.query.includes("query Channels")) {
      return Response.json({ data: { channels: availableChannels } });
    }
    if (body.query.includes("query Posts")) {
      const entries = body.variables.after ? nextPage : existing;
      return Response.json({
        data: {
          posts: {
            edges: entries.map((node) => ({ node })),
            pageInfo: {
              hasNextPage: !body.variables.after && nextPage.length > 0,
              endCursor: body.variables.after ? null : "next",
            },
          },
        },
      });
    }
    assert.ok(body.query.includes("createContentItem"));
    created.push(...body.variables.input.posts);
    return Response.json({
      data: {
        createContentItem: body.variables.input.posts.some(
          ({ channelId }) => channelId === failChannel,
        )
          ? {
              message: "Invalid channel variant",
              errors: [{ message: "Media required" }],
            }
          : { content: { id: "content-item" } },
      },
    });
  });
  const integration = buffer({
    posts: new URL("./posts.ts", import.meta.url),
    contentDirectory: "src/content/blog",
  });
  const routes = [];
  await integration.hooks["astro:config:setup"]({ injectRoute: (route) => routes.push(route) });
  await integration.hooks["astro:config:done"]({ config: { root: pathToFileURL(root + "/") } });
  const run = () =>
    integration.hooks["astro:build:done"]({
      dir,
      logger: Object.fromEntries(
        ["info", "warn"].map((level) => [level, (text) => logs.push(text)]),
      ),
    });
  return { run, requests, created, logs, manifest, routes, git };
}

test("ordinary builds do not inject routes or contact Buffer", async (t) => {
  const { run, requests, routes } = await setup(t, { enabled: false });
  await run();
  assert.deepEqual(routes, []);
  assert.deepEqual(requests, []);
});

test("shares only added articles in one batch, not edits, renames, or archive entries", async (t) => {
  const { run, created, manifest, routes, requests } = await setup(t);
  await run();
  assert.equal(routes[0].pattern, "/buffer-posts.json");
  assert.deepEqual(
    created,
    channels.map(({ id }) => ({
      channelId: id,
      text: `${article.title}\n\n${article.url}`,
      schedulingType: "automatic",
      mode: "shareNow",
    })),
  );
  const mutations = requests.filter(({ query }) => query.includes("mutation Publish"));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].variables.input.organizationId, "test-org");
  assert.equal(mutations[0].variables.input.title, article.title);
  await assert.rejects(readFile(manifest), { code: "ENOENT" });
});

test("checks all history pages and resumes only missing channels", async (t) => {
  const { run, created, requests } = await setup(t, {
    nextPage: [
      { id: "sent", channelId: "one", text: `Original title\n${article.url}`, status: "sent" },
    ],
  });
  await run();
  assert.deepEqual(
    created.map(({ channelId }) => channelId),
    ["two"],
  );
  assert.ok(requests.some(({ variables }) => variables.after === "next"));
});

test("completed reruns never recreate sent or scheduled shares", async (t) => {
  const { run, created } = await setup(t, {
    existing: channels.map(({ id }, index) => ({
      id: `post-${id}`,
      channelId: id,
      text: `${article.title}\n\n${article.url}`,
      status: index ? "scheduled" : "sent",
    })),
  });
  await run();
  assert.deepEqual(created, []);
});

test("reports experimental mutation failures with variant validation details", async (t) => {
  const { run, created } = await setup(t, { failChannel: "one" });
  await assert.rejects(run(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /New article.*Invalid channel variant.*Media required/);
    return true;
  });
  assert.equal(created.length, 2);
});

test("existing failed posts require attention instead of being duplicated", async (t) => {
  const { run, created } = await setup(t, {
    existing: [{ id: "failed", channelId: "one", text: article.url, status: "error" }],
  });
  await assert.rejects(run(), (error) => {
    assert.match(error.errors[0].message, /Review Buffer post failed/);
    return true;
  });
  assert.deepEqual(
    created.map(({ channelId }) => channelId),
    ["two"],
  );
});

test("missing credentials fail before contacting Buffer", async (t) => {
  const { run, requests } = await setup(t);
  delete process.env.BUFFER_API_KEY;
  await assert.rejects(run(), /Set BUFFER_API_KEY/);
  assert.deepEqual(requests, []);
});

test("an unchanged revision does nothing even without credentials", async (t) => {
  const { run, requests, git } = await setup(t);
  process.env.BUFFER_BASE_REF = git("rev-parse", "HEAD");
  delete process.env.BUFFER_API_KEY;
  await run();
  assert.deepEqual(requests, []);
});

test("invalid base revisions cannot accidentally backfill the archive", async (t) => {
  const { run, requests } = await setup(t);
  process.env.BUFFER_BASE_REF = "0".repeat(40);
  await assert.rejects(run(), /Set BUFFER_BASE_REF/);
  assert.deepEqual(requests, []);
});

test("HTTP and GraphQL failures are surfaced without retrying mutations", async (t) => {
  for (const [name, response] of [
    ["rate limit", new Response("Rate limited", { status: 429 })],
    ["GraphQL error", Response.json({ errors: [{ message: "Unauthorized" }] })],
    ["missing data", Response.json({})],
  ]) {
    await t.test(name, async (t) => {
      const { run } = await setup(t);
      let attempts = 0;
      t.mock.method(globalThis, "fetch", async () => {
        attempts++;
        return response;
      });
      await assert.rejects(run(), /Buffer/);
      assert.equal(attempts, 1);
    });
  }
});

test("disconnected or locked channels are reported without creating posts", async (t) => {
  const { run, created, logs } = await setup(t, {
    availableChannels: channels.map((channel) => ({ ...channel, isDisconnected: true })),
  });
  await assert.rejects(run(), /No connected, unlocked Buffer channels/);
  assert.deepEqual(created, []);
  assert.ok(logs.some((message) => message.includes("disconnected or locked")));
});

test("an unreachable production article fails before any write to Buffer", async (t) => {
  const { run, created } = await setup(t);
  const fetchBuffer = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (url === article.url) return Promise.resolve({ ok: false, status: 500 });
    return fetchBuffer(url, options);
  });
  await assert.rejects(run(), /Cannot verify.*HTTP 500/);
  assert.deepEqual(created, []);
});
