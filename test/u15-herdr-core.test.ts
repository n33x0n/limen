// U15 · a detached job spawned in a herdr-core terminal gets a log view in that terminal's space; HERDR_ENV=1 keeps legacy.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobDir, jobFile, limen, plant, spawnJob, until, waitJob } from "./plant.ts";
// Logs each argv; keeps terminals in core.json; t10, the caller, sits in space sp1. FAKE_CORE_FAIL makes every call fail.
const fake = (d: string) => `#!/usr/bin/env node
const fs = require("node:fs"), [v, ...a] = process.argv.slice(2).filter((x) => x !== "--json"), f = "${d}/core.json";
fs.appendFileSync("${d}/calls.jsonl", JSON.stringify([v, ...a]) + "\\n");
if (process.env.FAKE_CORE_FAIL) { console.error("core down"); process.exit(1); }
const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { n: 11, t: { t10: { labels: { "herdr.space": "sp1" } } } };
const t = c.t[a[0]], out = (r) => { fs.writeFileSync(f, JSON.stringify(c)); console.log(JSON.stringify(r)); };
const kv = (s) => [s.split("=")[0], s.slice(s.indexOf("=") + 1)];
if (v === "run") out((c.t["t" + c.n] = { address: "t" + c.n++, state: "live",
  labels: Object.fromEntries(a.filter((x, i) => a[i - 1] === "--label").map(kv)) }));
else if (!t || (v === "rm" && t.state === "live")) process.exit(1);
else if (v === "rm") { delete c.t[a[0]]; out({}); }
else { if (v === "kill") t.state = "finished"; out(t); }
`;
test("herdr-core views: argv, record, automatic close, open, prune; legacy route and a failing core", async (t) => {
	const p = await plant();
	t.after(() => p.cleanup());
	writeFileSync(join(p.parent, "herdr-core"), fake(p.parent), { mode: 0o755 });
	const env = { HC_TERMINAL_SOCKET: "/s.sock", HC_TERMINAL_ID: "t10", LIMEN_HERDR_CORE: join(p.parent, "herdr-core") };
	const read = (name: string) => readFileSync(join(p.parent, name), "utf8");
	const calls = () => read("calls.jsonl").replaceAll('"', "").trim().split("\n");
	const core = (): Record<string, { labels: Record<string, string> }> => JSON.parse(read("core.json")).t;
	const id = spawnJob(p, "say hi", ["--detached", "--label", "F001 core view"], { env });
	const log = join(jobDir(p, id), "log");
	assert.match(calls()[1] ?? "", /^\[run,--bg,--outlive-parent,--no-notify,/);
	assert.ok(calls()[1]?.endsWith(`limen.state=running,--,tail,-n,200,-F,${log}]`));
	const place = ["terminal", "space", "socket", "mode"].map((name) => jobFile(p, id, `herdr-core/${name}`));
	assert.deepEqual(place, ["t11", "sp1", "/s.sock", "watch"]);
	assert.equal(waitJob(p, id, { env }), "done");
	await until(p.parent, () => !existsSync(join(jobDir(p, id), "herdr-core")));
	assert.equal(core().t11, undefined);
	assert.ok(jobFile(p, id, "log") && jobFile(p, id, "result"));
	assert.equal(limen(p, ["open", id], { env }).stdout, "opened F001 core view in herdr-core as t12\n");
	assert.match(calls().at(-1) ?? "", /limen.state=done,--,tail,-n,\+1,-F,/, "a reopened view shows the whole log");
	assert.match(limen(p, ["prune", "--retire"], { env }).stdout, /retired 1 job/);
	assert.deepEqual([calls().slice(-3), core().t12], [["[get,t12]", "[kill,t12]", "[rm,t12]"], undefined]);
	const count = calls().length;
	assert.equal(waitJob(p, spawnJob(p, "say hi", ["--detached"], { env: { ...env, HERDR_ENV: "1" } }), { env }), "done");
	assert.equal(calls().length, count, "HERDR_ENV=1 keeps the legacy route");
	const failing = spawnJob(p, "say hi", ["--detached"], { env: { ...env, FAKE_CORE_FAIL: "1" } });
	assert.equal(waitJob(p, failing, { env }), "done");
	assert.match(jobFile(p, failing, "log"), /herdr-core skipped: herdr-core get: core down/);
	for (const state of ["failed", "stopped"]) {
		const next = spawnJob(p, state === "failed" ? "fail 1" : "block", ["--detached"], { env });
		if (state === "stopped") {
			await until(jobDir(p, next), () => existsSync(join(jobDir(p, next), "fake-blocked-1")));
			assert.equal(limen(p, ["stop", next], { env }).status, 0);
		}
		assert.equal(waitJob(p, next, { env }), state);
		await until(p.parent, () => !existsSync(join(jobDir(p, next), "herdr-core")));
		assert.equal(Object.values(core()).some((row) => row.labels["limen.job"] === next), false);
	}
});
