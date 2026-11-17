import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

type Volume = { mount: string; uuid: string; device: number };

function configuredVolume(): Volume | undefined {
	const config = join(homedir(), ".config", "limen", "volume-storage.json");
	if (!existsSync(config)) return undefined;
	let value: unknown;
	try { value = JSON.parse(readFileSync(config, "utf8")); } catch { throw new Error(`invalid volume configuration: ${config}`); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid volume configuration");
	const data = value as Record<string, unknown>;
	if (Object.keys(data).sort().join(",") !== "mount,uuid" || typeof data.mount !== "string" || !isAbsolute(data.mount) || resolve(data.mount) !== data.mount || typeof data.uuid !== "string" || !/^[0-9a-fA-F-]{8,64}$/.test(data.uuid)) throw new Error("invalid volume configuration: expected absolute mount and UUID");
	try {
		const mount = realpathSync(data.mount);
		if (mount !== data.mount) throw new Error("mount is a symlink");
		const filesystem = statSync(mount);
		const device = statSync(`/dev/disk/by-uuid/${data.uuid}`);
		if (!filesystem.isDirectory() || !device.isBlockDevice() || filesystem.dev !== device.rdev || statSync(dirname(mount)).dev === filesystem.dev) throw new Error("volume identity mismatch");
		return { mount, uuid: data.uuid, device: filesystem.dev };
	} catch { throw new Error(`configured Limen volume is missing or does not match UUID ${data.uuid}: ${data.mount}`); }
}

/** Check the configured filesystem before publishing a job or restoring its worktree. */
export function checkVolumeStorage(): void { configuredVolume(); }

/** Preserve old mounted paths and provision only paths that do not exist yet. */
export function prepareVolumePath(path: string): void {
	const volume = configuredVolume();
	if (!volume) return;
	const visible = resolve(path);
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
