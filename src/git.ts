import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

function isDraft(source: string) {
  const lines = (source.startsWith("\uFEFF") ? source.slice(1) : source).split("\n");
  if (lines.length < 2 || lines[0].trimEnd() !== "---") return false;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) throw new Error("Missing closing YAML frontmatter delimiter.");
  const data: unknown = parse(lines.slice(1, end).join("\n"));
  return typeof data === "object" && data !== null && "draft" in data && data.draft === true;
}

export function findNewArticles<T extends { filePath: string }>(
  articles: T[],
  root: URL,
  contentDirectory: string,
): T[] {
  const base = process.env.BUFFER_BASE_REF;
  if (!base || !/^[a-f0-9]{40}$/i.test(base) || /^0+$/.test(base)) {
    throw new Error("Set BUFFER_BASE_REF to the full commit SHA before the new posts.");
  }
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fileURLToPath(root), encoding: "utf8" });
  const changes = git(
    "diff",
    "--name-status",
    "--relative",
    "-z",
    "--diff-filter=AMR",
    "--find-renames",
    base,
    "HEAD",
    "--",
    contentDirectory,
  )
    .split("\0")
    .filter(Boolean);
  const previousPaths = new Map<string, string | undefined>();
  for (let index = 0; index < changes.length;) {
    const status = changes[index++];
    const path = changes[index++];
    if (status.startsWith("R")) {
      previousPaths.set(changes[index++], path);
    } else {
      previousPaths.set(path, status === "A" ? undefined : path);
    }
  }
  return articles.filter(({ filePath }) => {
    if (!previousPaths.has(filePath)) return false;
    const previousPath = previousPaths.get(filePath);
    if (previousPath && !isDraft(git("show", `${base}:./${previousPath}`))) {
      return false;
    }
    return !isDraft(git("show", `HEAD:./${filePath}`));
  });
}
