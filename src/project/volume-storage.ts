import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

type Volume = { mount: string; uuid: string; device: number; workspace?: string };

function configuredVolume(): Volume | undefined {
	const config = join(homedir(), ".config", "limen", "volume-storage.json");
	if (!existsSync(config)) return undefined;
	let value: unknown;
	try { value = JSON.parse(readFileSync(config, "utf8")); } catch { throw new Error(`invalid volume configuration: ${config}`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid volume configuration");
	const data = value as Record<string, unknown>;
	const keys = Object.keys(data).sort().join(",");
	const named = keys === "layout,mount,uuid,workspace" && data.layout === "named" && typeof data.workspace === "string" && isAbsolute(data.workspace) && resolve(data.workspace) === data.workspace;
	if ((keys !== "mount,uuid" && !named) || typeof data.mount !== "string" || !isAbsolute(data.mount) || resolve(data.mount) !== data.mount || typeof data.uuid !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(data.uuid)) throw new Error("invalid volume configuration: expected absolute mount and UUID, optionally workspace and named layout");
	try {
		const mount = realpathSync(data.mount);
		if (mount !== data.mount) throw new Error("mount is a symlink");
		const filesystem = statSync(mount);
		const device = statSync(`/dev/disk/by-uuid/${data.uuid}`);
		if (!filesystem.isDirectory() || !device.isBlockDevice() || filesystem.dev !== device.rdev || statSync(dirname(mount)).dev === filesystem.dev) throw new Error("volume identity mismatch");
		return { mount, uuid: data.uuid, device: filesystem.dev, ...(named ? { workspace: data.workspace as string } : {}) };
	} catch { throw new Error(`configured Limen volume is missing or does not match UUID ${data.uuid}: ${data.mount}`); }
}

/** Check the configured filesystem before publishing a job or restoring its worktree. */
export function checkVolumeStorage(): void { configuredVolume(); }

/** Preserve old mounted paths and provision only paths that do not exist yet. */
export function prepareVolumePath(path: string): void {
	const volume = configuredVolume();
	if (!volume) return;
	const visible = resolve(path);
	if (volume.workspace) {
		prepareNamedPath(visible, volume);
		return;
	}
	try {
		lstatSync(visible);
		const existing = statSync(visible);
		if (!existing.isDirectory() || existing.dev !== volume.device) throw new Error(`existing Limen storage is not on the configured volume: ${visible}`);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		try { lstatSync(visible); throw new Error(`Limen storage target is unavailable: ${visible}`); } catch (missing) {
			if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
		}
	}
	const key = createHash("sha256").update(visible).digest("hex");
	const target = join(volume.mount, "limen-managed", key);
	mkdirSync(target, { recursive: true, mode: 0o700 });
	if (statSync(target).dev !== volume.device) throw new Error(`Limen storage is not on configured volume: ${target}`);
	mkdirSync(dirname(visible), { recursive: true });
	try { symlinkSync(target, visible, "dir"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = statSync(visible);
		if (!existing.isDirectory() || existing.dev !== volume.device) throw new Error(`existing Limen storage is not on the configured volume: ${visible}`);
	}
}

function namedTarget(visible: string, volume: Volume): string {
	const workspace = volume.workspace;
	if (!workspace) {
		throw new Error("named Limen storage requires a workspace");
	}
	const cabinet = dirname(visible);
	const owner = dirname(cabinet);
	if (basename(visible) === "jobs" && basename(cabinet) === ".limen") {
		if (owner === workspace) return join(volume.mount, "limen-jobs", "workspace");
		if (dirname(owner) === workspace && basename(owner) !== "_legacy" && !basename(owner).startsWith(".")) {
			return join(volume.mount, "limen-jobs", "plants", basename(owner));
		}
	}
	const match = /^\.(.+)-limen-worktrees(?:-(.+))?$/.exec(basename(visible));
	const repositoryName = match?.[1];
	if (dirname(visible) === workspace && repositoryName && repositoryName !== "_legacy" &&
		!repositoryName.startsWith(".")) {
		if (match?.[2]) {
			return join(volume.mount, "limen-worktrees", "_legacy", basename(visible).slice(1));
		}
		const repository = join(workspace, repositoryName);
		try {
			const common = execFileSync("git",
				["-C", repository, "rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
			if (realpathSync(common) !== join(realpathSync(repository), ".git") ||
				realpathSync(repository) !== repository) {
				throw new Error("not a main repository");
			}
		} catch {
			throw new Error(`cannot identify named worktree repository: ${repository}`);
		}
		return join(volume.mount, "limen-worktrees", repositoryName);
	}
	throw new Error(`unsupported named Limen storage path: ${visible}`);
}

function present(path: string): boolean {
	try { lstatSync(path); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function sameDirectory(left: string, right: string): boolean {
	const a = statSync(left);
	const b = statSync(right);
	return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
}

/** Named destinations cannot hide symlinks or secondary mounts into hash storage. */
function physicalDirectory(path: string, volume: Volume): void {
	const info = lstatSync(path);
	if (!info.isDirectory() || info.dev !== volume.device || realpathSync(path) !== path) throw new Error(`named Limen storage is not a physical volume directory: ${path}`);
	const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
	if (mounts.some((line) => {
		const mount = line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
		return mount === path;
	})) throw new Error(`named Limen storage is a secondary mount: ${path}`);
}

function prepareNamedPath(visible: string, volume: Volume): void {
	const target = namedTarget(visible, volume);
	const owner = basename(visible) === "jobs" ? dirname(dirname(visible)) : dirname(visible);
	if (realpathSync(owner) !== owner) {
		throw new Error(`named Limen storage owner is a symlink: ${owner}`);
	}
	// Validate every existing destination component before creating anything.
	const components: string[] = [];
	for (let path = target; path !== volume.mount; path = dirname(path)) components.unshift(path);
	for (const path of components) if (present(path)) physicalDirectory(path, volume);
	if (present(visible)) {
		if (!present(target) || !sameDirectory(visible, target)) throw new Error(`named Limen storage identity mismatch: ${visible} != ${target}`);
		return;
	}
	if (present(target)) throw new Error(`named Limen storage destination already exists without its alias: ${target}`);
	for (const path of components) {
		try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			if (path === target) {
				physicalDirectory(target, volume);
				if (present(visible) && sameDirectory(visible, target)) {
					return;
				}
				throw new Error(`named Limen storage destination collision: ${target}`);
			}
		}
		physicalDirectory(path, volume);
	}
	mkdirSync(dirname(visible), { recursive: true });
	try { symlinkSync(target, visible, "dir"); } catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !sameDirectory(visible, target)) throw error;
	}
	if (!sameDirectory(visible, target)) throw new Error(`named Limen storage identity mismatch: ${visible} != ${target}`);
}
