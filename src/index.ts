import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";
import { z } from "astro/zod";
import { findNewArticles } from "./git.js";
import { publishPosts } from "./publish.js";

const articlesSchema = z
  .array(
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
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.hash
          );
        }, "url must be an absolute HTTP(S) URL without whitespace, credentials, or a fragment."),
        text: z
          .string({ message: "announcement text must be a non-empty string." })
          .refine((text) => text.trim(), "announcement text must be a non-empty string.")
          .optional(),
        mode: z.enum(["shareNow", "addToQueue"]).optional(),
      },
      { message: "must be an object." },
    ),
    { message: "Buffer manifest must be an array of articles." },
  )
  .superRefine((articles, context) => {
    const urls = new Set<string>();
    for (const [index, { url }] of articles.entries()) {
      if (urls.has(url)) {
        context.addIssue({
          code: "custom",
          path: [index, "url"],
          message: `Duplicate article URL: ${url}.`,
        });
      }
      urls.add(url);
    }
  });

export interface BufferOptions {
  posts: URL;
  contentDirectory: string;
  channelIds?: string[];
  mode?: "shareNow" | "addToQueue";
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
    name: "astro-buffalo",
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

        const posts = findNewArticles(articles, root, contentDirectory).map((article) => ({
          ...article,
          text: `${article.text?.trim() ?? article.title}\n\n${article.url}`,
          mode: article.mode ?? mode,
        }));
        if (!posts.length) {
          logger.info("No new blog posts to share.");
          return;
        }

        await publishPosts(posts, { channelIds, dryRun, logger });
      },
    },
  };
}
