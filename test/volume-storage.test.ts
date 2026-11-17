import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { limen, plant } from "./plant.ts";

test("a missing configured volume refuses spawn and continuation without creating a job", async () => {
	const p = await plant();
	try {
		const config = join(p.env.HOME, ".config", "limen");
		await mkdir(config, { recursive: true });
		await writeFile(join(config, "volume-storage.json"), JSON.stringify({ mount: p.parent, uuid: "00000000-0000-0000-0000-000000000000" }));
		const jobs = join(p.root, ".limen", "jobs");
		const before = await readdir(jobs);
		for (const args of [["spawn", "--engine", "omp", "work"], ["continue", "missing", "work"]]) {
			const result = limen(p, args);
			assert.equal(result.status, 1);
			assert.match(result.stderr, /configured Limen volume is missing or does not match/);
			assert.deepEqual(await readdir(jobs), before);
		}
	} finally {
		await p.cleanup();
	}
});
