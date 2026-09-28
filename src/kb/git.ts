/**
 * 正式知识库（kb.yaml）的 git 留痕。
 *
 * 容器里既没有全局 git 配置、也没有签名密钥，所以这里对每条命令显式带上
 * `user.name` / `user.email`、关闭 commit 签名（`commit.gpgsign=false`，否则会因为
 * 找不到签名密钥而提交失败），并把仓库目录标成 `safe.directory`（bind mount 的属主
 * 与容器用户对不上时 git 会拒绝操作）。
 *
 * 任何一步失败都**只返回原因、不抛错**：文件已经写盘并热重载了，提交失败不该让用户
 * 以为改动没生效。调用方把原因写进日志和审计，并在 toast 里带一句提示。
 */
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;

export interface GitCommitOptions {
  /** 仓库根目录。 */
  repo: string;
  /** 要提交的文件（相对当前工作目录或绝对路径，都会换算成相对仓库根的路径）。 */
  paths: string[];
  /** 完整提交信息。 */
  message: string;
  authorName: string;
  authorEmail: string;
  /** 提交后是否 push。 */
  push: boolean;
  /** push 的远端名。 */
  remote: string;
}

export type GitCommitResult = { ok: true; pushed: boolean } | { ok: false; reason: string };

/** 把 execFile 的报错压成一行可读文本（git 的原因都在 stderr 末行）。 */
function reasonOf(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim() !== "") {
      const lines = stderr.trim().split("\n");
      return lines[lines.length - 1]!.trim();
    }
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message.split("\n")[0]!.trim();
  }
  return String(err);
}

/**
 * 把若干路径提交进仓库。只提交列出的路径：`git commit -- <paths>` 是路径限定提交，
 * 不会顺手把别人留在索引里的改动一起带走（这正是服务器上仓库用途单一、但有历史残留时的保险）。
 */
export async function commitPaths(opts: GitCommitOptions): Promise<GitCommitResult> {
  const repo = resolve(opts.repo);
  const rels: string[] = [];
  for (const path of opts.paths) {
    const rel = relative(repo, resolve(path));
    if (rel === "" || rel.split(/[\\/]/)[0] === "..") {
      return { ok: false, reason: `${path} 不在仓库 ${repo} 内` };
    }
    rels.push(rel);
  }

  const base = [
    "-C",
    repo,
    "-c",
    `safe.directory=${repo}`,
    "-c",
    `user.name=${opts.authorName}`,
    "-c",
    `user.email=${opts.authorEmail}`,
    "-c",
    "commit.gpgsign=false",
  ];

  try {
    await run("git", [...base, "add", "--", ...rels], { cwd: repo, timeout: TIMEOUT_MS });
    await run("git", [...base, "commit", "-m", opts.message, "--", ...rels], { cwd: repo, timeout: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }

  if (!opts.push) return { ok: true, pushed: false };
  try {
    await run("git", [...base, "push", opts.remote, "HEAD"], { cwd: repo, timeout: TIMEOUT_MS });
    return { ok: true, pushed: true };
  } catch (err) {
    return { ok: false, reason: `已提交但推送失败：${reasonOf(err)}` };
  }
}
