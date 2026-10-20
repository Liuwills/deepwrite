import type { PluginManifest } from "@deepwrite/contracts";
import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readPluginManifest } from "./plugin-manifest";

const run = promisify(execFile);

const MAX_PLUGIN_FILES = 5_000;
const MAX_PLUGIN_BYTES = 200 * 1024 * 1024;

export interface InstalledPluginDirectory {
  directory: string;
  manifest: PluginManifest;
}

export interface PluginInstallRequest {
  source: "local" | "npm" | "github";
  spec: string;
}

/** Installs one plugin and returns its final directory inside the plugins root. */
export async function installPluginDirectory(
  request: PluginInstallRequest,
  pluginsDirectory: string
): Promise<InstalledPluginDirectory> {
  await mkdir(pluginsDirectory, { recursive: true });
  const stagingRoot = await mkdtemp(join(pluginsDirectory, ".install-"));
  try {
    const sourceDirectory =
      request.source === "local"
        ? await resolveLocalSource(request.spec)
        : request.source === "npm"
          ? await unpackNpmPackage(request.spec, stagingRoot)
          : await cloneGitRepository(request.spec, stagingRoot);
    await assertPluginSize(sourceDirectory);
    const manifest = await readPluginManifest(sourceDirectory);
    const target = join(pluginsDirectory, manifest.id);
    const staged = join(stagingRoot, `plugin-${manifest.id}`);
    await cp(sourceDirectory, staged, {
      recursive: true,
      filter: (path) => !path.includes(`${sep}.git${sep}`)
    });
    await rm(target, { recursive: true, force: true });
    await rename(staged, target);
    return { directory: target, manifest };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function resolveLocalSource(spec: string): Promise<string> {
  const directory = resolve(spec.replace(/^file:\/\//u, ""));
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new Error(`本地插件目录不存在：${spec}`);
  }
  return directory;
}

async function unpackNpmPackage(
  spec: string,
  stagingRoot: string
): Promise<string> {
  const destination = join(stagingRoot, "npm");
  await mkdir(destination, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let archive: string;
  try {
    const { stdout } = await run(
      npm,
      ["pack", spec, "--pack-destination", destination, "--silent"],
      { timeout: 180_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    archive = join(destination, stdout.trim().split(/\r?\n/u).pop() ?? "");
    await stat(archive);
  } catch (error) {
    throw new Error(
      `npm 包安装失败：${describeError(error)}。请确认已安装 Node.js 与 npm，或改用本地目录 / GitHub 方式安装。`
    );
  }
  const extractRoot = join(stagingRoot, "npm-extract");
  await mkdir(extractRoot, { recursive: true });
  await extractTarball(await readFile(archive), extractRoot);
  return locateManifestDirectory(extractRoot);
}

async function cloneGitRepository(
  spec: string,
  stagingRoot: string
): Promise<string> {
  const destination = join(stagingRoot, "git");
  const url = /^[a-z]+:\/\//iu.test(spec) ? spec : `https://github.com/${spec}`;
  try {
    await run("git", ["clone", "--depth", "1", "--", url, destination], {
      timeout: 180_000,
      windowsHide: true
    });
  } catch (error) {
    throw new Error(
      `GitHub 仓库安装失败：${describeError(error)}。请确认本机可访问 Git 与网络。`
    );
  }
  return destination;
}

/** npm tarballs usually nest the payload under `package/`. */
async function locateManifestDirectory(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => entry.name === "plugin.json")) return root;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    const hasManifest = await stat(join(candidate, "plugin.json"))
      .then((info) => info.isFile())
      .catch(() => false);
    if (hasManifest) return candidate;
  }
  throw new Error("安装包中没有找到 plugin.json 清单。");
}

async function assertPluginSize(directory: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      bytes += (await stat(path)).size;
      if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES) {
        throw new Error("插件体积超出限制（最多 5000 个文件 / 200MB）。");
      }
    }
  };
  await walk(directory);
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as { stderr?: unknown; message?: unknown };
    const stderr =
      typeof record.stderr === "string" ? record.stderr.trim() : "";
    if (stderr) return stderr.split(/\r?\n/u).slice(-3).join(" ");
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}

/** Minimal ustar reader; npm archives only contain files, folders and links. */
async function extractTarball(
  archive: Buffer,
  destination: string
): Promise<void> {
  let buffer: Buffer;
  try {
    buffer = gunzipSync(archive);
  } catch {
    throw new Error("npm 包不是有效的压缩归档。");
  }
  const root = resolve(destination);
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarString(header, 124, 12).trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const target = resolve(root, fullName.replace(/^(\.\.?\/)+/u, ""));
    if (!target.startsWith(`${root}${sep}`) && target !== root) {
      throw new Error("npm 包含有不安全的路径，已停止解压。");
    }
    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0" || type === "7") {
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, buffer.subarray(dataStart, dataStart + size));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}
