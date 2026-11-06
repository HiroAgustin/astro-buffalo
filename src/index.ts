import { execFileSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AstroIntegration, AstroIntegrationLogger } from "astro";
import { z } from "astro/zod";

const articlesSchema = z.array(
  z.object(
    {
      filePath: z
        .string()
        .refine(
          (path) =>
            path.trim() &&
            !path.startsWith("/") &&
            !path.includes("\\") &&
            !path.split("/").some((part) => part === "." || part === "..") &&
            !/^[a-z]:/i.test(path),
          "filePath must be a project-relative path using forward slashes.",
        ),
      title: z.string().refine((title) => title.trim(), "title must be a non-empty string."),
      url: z.string().refine((value) => {
        if (/\s/.test(value) || !URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
        );
      }, "url must be an absolute HTTP(S) URL without whitespace, credentials, or a fragment."),
      text: z
        .string({ message: "announcement text must be a non-empty string." })
        .refine((text) => text.trim(), "announcement text must be a non-empty string.")
        .optional(),
    },
    { message: "must be an object." },
  ),
  { message: "Buffer manifest must be an array of articles." },
);

export interface BufferOptions {
  posts: URL;
  contentDirectory: string;
  channelIds?: string[];
  mode?: "shareNow" | "addToQueue";
}

interface Channel {
  id: string;
  name: string;
  isDisconnected: boolean;
  isLocked: boolean;
}

interface BufferPost {
  id: string;
  text: string;
  channelId: string;
  status: string;
}

interface PostHistory {
  posts: {
    edges: { node: BufferPost }[] | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function waitForDeployment(url: string, logger: AstroIntegrationLogger): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof Error && error.name === "TimeoutError")
      ) {
        throw error;
      }
      logger.warn(`Cannot reach ${url}: ${error.message}. Retrying.`);
    }
    if (response) {
      if (response.ok && response.url === url) return;
      if (![404, 502, 503, 504].includes(response.status)) {
        throw new Error(`Cannot verify ${url}: HTTP ${response.status}.`);
      }
    }
    logger.info(`Waiting for ${url} to be deployed...`);
    await timers.setTimeout(10_000);
  }
  throw new Error(`${url} is not live yet. Rerun after deployment succeeds.`);
}

async function request<T>(token: string, query: string, variables: object): Promise<T> {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(
      `Buffer request failed: HTTP ${response.status}.${retryAfter ? ` Retry after ${retryAfter} seconds.` : ""}`,
    );
  }

  const result: { data?: T; errors?: { message: string }[] } = await response.json();
  if (result.errors?.length) {
    throw new Error(`Buffer: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  if (!result.data) {
    throw new Error("Buffer returned no data.");
  }
  return result.data;
}

export default function buffer({
  posts: entrypoint,
  contentDirectory,
  channelIds,
  mode = "shareNow",
}: BufferOptions): AstroIntegration {
  if (mode !== "shareNow" && mode !== "addToQueue") {
    throw new Error('mode must be "shareNow" or "addToQueue".');
  }
  if (channelIds && (!channelIds.length || channelIds.some((id) => !id.trim()))) {
    throw new Error("channelIds must contain at least one non-empty Buffer channel ID.");
  }
  let root: URL;
  let enabled = false;
  const dryRun = process.env.BUFFER_DRY_RUN === "true";

  return {
    name: "astro-buffer",
    hooks: {
      "astro:config:setup": ({ injectRoute, command }) => {
        enabled = command === "build" && process.env.BUFFER_PUBLISH === "true";
        if (enabled) {
          injectRoute({
            pattern: "/buffer-posts.json",
            entrypoint: fileURLToPath(entrypoint),
            prerender: true,
          });
        }
      },
      "astro:config:done": ({ config }) => {
        root = config.root;
      },
      "astro:build:done": async ({ dir, logger }) => {
        if (!enabled) return;

        const manifest = new URL("buffer-posts.json", dir);
        const contents = await readFile(manifest, "utf8");
        await unlink(manifest);
        const result = articlesSchema.safeParse(JSON.parse(contents));
        if (!result.success) {
          throw new Error(
            result.error.issues
              .map(({ path, message }) =>
                [
                  typeof path[0] === "number" && `Buffer manifest article ${path[0] + 1}`,
                  path[1] && `(${String(path[1])})`,
                  message,
                ]
                  .filter(Boolean)
                  .join(" "),
              )
              .join("\n"),
          );
        }
        const articles = result.data;

        const base = process.env.BUFFER_BASE_REF;
        if (!base || !/^[a-f0-9]{40}$/i.test(base) || /^0+$/.test(base)) {
          throw new Error("Set BUFFER_BASE_REF to the full commit SHA before the new posts.");
        }
        const added = new Set(
          execFileSync(
            "git",
            [
              "diff",
              "--name-only",
              "--relative",
              "-z",
              "--diff-filter=A",
              "--find-renames",
              base,
              "HEAD",
              "--",
              contentDirectory,
            ],
            { cwd: fileURLToPath(root), encoding: "utf8" },
          )
            .split("\0")
            .filter(Boolean),
        );
        const posts = articles
          .filter((article) => added.has(article.filePath))
          .map((article) => ({
            ...article,
            text: `${article.text?.trim() ?? article.title}\n\n${article.url}`,
          }));
        if (!posts.length) {
          logger.info("No new blog posts to share.");
          return;
        }

        const token = process.env.BUFFER_API_KEY;
        const organizationId = process.env.BUFFER_ORGANIZATION_ID;
        if (!token || !organizationId) {
          throw new Error("Set BUFFER_API_KEY and BUFFER_ORGANIZATION_ID before publishing.");
        }

        const { channels } = await request<{ channels: Channel[] }>(
          token,
          `query Channels($input: ChannelsInput!) {
            channels(input: $input) { id name isDisconnected isLocked }
          }`,
          { input: { organizationId } },
        );
        if (channelIds) {
          const unknown = channelIds.filter((id) => !channels.some((channel) => channel.id === id));
          if (unknown.length) {
            throw new Error(`Unknown Buffer channel IDs: ${unknown.join(", ")}.`);
          }
        }
        const connected = channels.filter((channel) => {
          if (channelIds && !channelIds.includes(channel.id)) return false;
          if (channel.isDisconnected || channel.isLocked) {
            logger.warn(`Cannot publish to "${channel.name}": disconnected or locked in Buffer.`);
            return false;
          }
          return true;
        });
        if (!connected.length) {
          throw new Error("No connected, unlocked Buffer channels found.");
        }

        const existing: BufferPost[] = [];
        let after: string | null = null;
        do {
          const { posts: page }: PostHistory = await request<PostHistory>(
            token,
            `query Posts($input: PostsInput!, $after: String) {
              posts(input: $input, first: 100, after: $after) {
                edges { node { id text channelId status } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            {
              input: { organizationId, filter: { channelIds: connected.map(({ id }) => id) } },
              after,
            },
          );
          if (!page.edges) {
            throw new Error("Buffer returned no post history.");
          }
          existing.push(...page.edges.map(({ node }) => node));
          if (
            page.pageInfo.hasNextPage &&
            (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)
          ) {
            throw new Error("Buffer returned an invalid pagination cursor.");
          }
          after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        } while (after);

        const failures: Error[] = [];
        for (const article of posts) {
          const pending: Channel[] = [];
          for (const channel of connected) {
            const shared = existing.find(
              (post) =>
                post.channelId === channel.id && post.text.split(/\s+/).includes(article.url),
            );
            if (shared) {
              if (!["sent", "scheduled", "sending"].includes(shared.status)) {
                failures.push(
                  new Error(
                    `Review Buffer post ${shared.id} for "${channel.name}": ${shared.status}.`,
                  ),
                );
              }
              logger.info(`Already in Buffer: "${article.title}" -> "${channel.name}".`);
              continue;
            }

            pending.push(channel);
          }
          if (!pending.length) continue;

          if (dryRun) {
            logger.info(
              `Dry run: ${JSON.stringify({
                title: article.title,
                text: article.text,
                channels: pending.map(({ id, name }) => ({ id, name })),
                mode,
              })}`,
            );
            continue;
          }

          await waitForDeployment(article.url, logger);

          const { createContentItem } = await request<{
            createContentItem: {
              content?: { id: string };
              message?: string;
              errors?: { message: string }[];
            };
          }>(
            token,
            `mutation Publish($input: CreateContentItemInput!) {
              createContentItem(input: $input) {
                ... on CreateContentItemSuccess { content { id } }
                ... on CreateContentItemFailure {
                  message
                  errors { ... on MutationError { message } }
                }
              }
            }`,
            {
              input: {
                organizationId,
                title: article.title,
                posts: pending.map(({ id }) => ({
                  channelId: id,
                  text: article.text,
                  schedulingType: "automatic",
                  mode,
                })),
              },
            },
          );
          if (!createContentItem.content?.id) {
            failures.push(
              new Error(
                `"${article.title}": ${[
                  createContentItem.message ?? "No content item ID returned.",
                  ...(createContentItem.errors ?? []).map(({ message }) => message),
                ].join("; ")}`,
              ),
            );
            continue;
          }
          logger.info(
            `Submitted "${article.title}" to ${pending.length} channels (${createContentItem.content.id}).`,
          );
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            [
              "Some Buffer posts need attention; reruns skip existing posts.",
              ...failures.map((error) => error.message),
            ].join("\n"),
          );
        }
      },
    },
  };
}
