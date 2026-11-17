import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { git, jobFile, limen, plant, repository, spawnJob, TICKET, waitJob } from "./plant.ts";

// Only mount metadata is synthetic. CLI publication, job records, aliases and Git use real files.
test("named storage preserves consumers and refuses identity and namespace collisions", async () => {
	const p = await plant();
	try {
		const volume = join(p.parent, "volume");
		const config = join(p.env.HOME, ".config/limen/volume-storage.json");
		const preload = join(p.parent, "volume.mjs");
		const uuid = "00000000-0000-0000-0000-000000000000";
		await mkdir(volume);
		await mkdir(join(p.env.HOME, ".config/limen"), { recursive: true });
		await writeFile(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.statSync;
const volume = ${JSON.stringify(volume)};
fs.statSync = function(path, ...args) {
 if (path === '/dev/disk/by-uuid/${uuid}') return { isBlockDevice: () => true, rdev: original(volume).dev };
 const value = original(path, ...args);
 if (path === ${JSON.stringify(p.parent)}) return new Proxy(value, {get: (target, key) => key === 'dev' ? target.dev + 1 : Reflect.get(target, key)});
 return value;
};
syncBuiltinESMExports();`);
		const options = { env: { NODE_OPTIONS: `${p.env.NODE_OPTIONS} --import=${preload}` } };
		const configure = async (extra: object = { workspace: p.parent, layout: "named" }) => {
			await writeFile(config, JSON.stringify({ mount: volume, uuid, ...extra }));
		};
		const prepare = (path: string) => spawnSync(process.execPath, ["--input-type=module", "-e",
			`import {prepareVolumePath} from ${JSON.stringify(new URL("../src/project/volume-storage.ts", import.meta.url).href)}; prepareVolumePath(${JSON.stringify(path)});`],
			{ encoding: "utf8", env: { ...p.env, ...options.env } });
		const accepts = (path: string) => {
			const result = prepare(path);
			assert.equal(result.status, 0, result.stderr);
		};
		const refuses = (path: string, reason: RegExp) => {
			const result = prepare(path);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, reason);
		};
		await configure();
		await rm(join(p.root, ".limen/jobs"), { recursive: true });
		const id = spawnJob(p, TICKET, ["--engine", "omp", "--detached"], options);
		assert.equal(waitJob(p, id, options), "done");
		assert.equal(realpathSync(join(p.root, ".limen/jobs")), join(volume, "limen-jobs/plants/repo"));
		const tree = jobFile(p, id, "worktree");
		assert.equal(realpathSync(tree), join(volume, "limen-worktrees/repo", id));
		assert.ok(git(p.root, "worktree", "list", "--porcelain").includes(realpathSync(tree)));
		assert.ok(limen(p, ["jobs"], options).stdout.includes(id));
		const continued = limen(p, ["continue", id, "continue synthetic work"], options);
		assert.equal(continued.status, 0, continued.stderr);
		const next = continued.stdout.trim().split("\n").at(-1) ?? "";
		assert.equal(waitJob(p, next, options), "done");
		assert.equal(jobFile(p, next, "worktree"), tree);
		await repository(join(p.parent, "other"));
		accepts(join(p.parent, ".other-limen-worktrees"));
		const untouched = join(volume, "limen-worktrees/other/keep");
		await mkdir(untouched);
		const pruned = limen(p, ["prune"], options);
		assert.equal(pruned.status, 0, pruned.stderr);
		assert.equal(existsSync(tree), false);
		assert.equal(existsSync(untouched), true);
		console.log("PROOF named publication, reads, continue, Git and project-scoped prune");

		// Workspace and independent plant records with the same ID remain separate.
		accepts(join(p.parent, ".limen/jobs"));
		await writeFile(join(volume, "limen-jobs/workspace", "same-id"), "workspace");
		await writeFile(join(volume, "limen-jobs/plants/repo", "same-id"), "plant");
		const mega = join(p.parent, "mega-dev");
		await mkdir(mega);
		const cabinet = join(p.parent, "cabinet");
		await mkdir(cabinet);
		await symlink(cabinet, join(mega, ".limen"));
		accepts(join(mega, ".limen/jobs"));
		assert.equal(realpathSync(join(mega, ".limen/jobs")), join(volume, "limen-jobs/plants/mega-dev"));
		const historical = join(p.parent, ".repo-limen-worktrees-old");
		accepts(historical);
		assert.equal(realpathSync(historical), join(volume, "limen-worktrees/_legacy/repo-limen-worktrees-old"));
		// A managed alias to the exact named inode remains a valid old entry point.
		const visible = join(p.root, ".limen/jobs");
		const managed = join(volume, "limen-managed/old");
		await mkdir(join(volume, "limen-managed"));
		await symlink(join(volume, "limen-jobs/plants/repo"), managed);
		await rm(visible);
		await symlink(managed, visible);
		accepts(visible);
		assert.equal(readFileSync(join(p.parent, ".limen/jobs/same-id"), "utf8"), "workspace");
		console.log("PROOF workspace, plant, MEGA cabinet, historical and chained old aliases");

		await rm(visible);
		const hash = join(volume, "limen-managed/hash");
		await mkdir(hash);
		await symlink(hash, visible);
		refuses(visible, /identity mismatch/);
		await rm(visible);
		refuses(visible, /already exists without its alias/);
		await symlink(managed, visible);
		const bad = join(p.parent, "bad/.limen/jobs");
		await mkdir(join(p.parent, "bad/.limen"), { recursive: true });
		const badTarget = join(volume, "limen-jobs/plants/bad");
		await symlink(hash, badTarget);
		refuses(bad, /not a physical volume directory/);
		assert.equal(existsSync(bad), false);
		refuses(join(p.parent, "nested/repo/.limen/jobs"), /unsupported named/);
		refuses(join(p.parent, "_legacy/.limen/jobs"), /unsupported named/);
		await configure({ workspace: `${p.parent}/../bad`, layout: "named" });
		refuses(visible, /invalid volume configuration/);
		await writeFile(config, JSON.stringify({ mount: volume, uuid: "11111111-1111-1111-1111-111111111111", workspace: p.parent, layout: "named" }));
		const failed = limen(p, ["spawn", "--engine", "omp", TICKET], options);
		assert.equal(failed.status, 1);
		assert.match(failed.stderr, /does not match UUID/);
		console.log("PROOF different inode, orphan destination, hash alias, symlink escape, out-of-scope and wrong UUID refuse");

		await configure({});
		const old = join(p.parent, "old-storage");
		accepts(old);
		assert.equal(realpathSync(old), join(volume, "limen-managed", createHash("sha256").update(old).digest("hex")));
		accepts(old);
		await rename(config, `${config}.saved`);
		const absent = join(p.parent, "absent-config");
		accepts(absent);
		assert.equal(existsSync(absent), false);
		console.log("PROOF two-field managed config and absent config compatibility");
	} finally {
		await p.cleanup();
	}
});
