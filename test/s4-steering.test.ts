// S4 · Steering and context injection. A running worker gets each steer once, in order, and an ended one refuses a
// late steer; every prompt carries the project's guidance once, also after a second `limen init` over old hook copies
// (236b8e7); `limen continue` resumes the old session with the parent's extensions or a replacement.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readToolPolicy } from "../src/runtime/tool-policy.ts";
import {
	engineEvents,
	git,
	jobDir,
	jobFile,
	limen,
	type Plant,
	plant,
	release,
	spawnJob,
	until,
	waitJob,
} from "./plant.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const FLAGS = ["--engine", "pi", "--detached"];
// One marker per project guidance source; the package capability frame and its cue are read from their own file.
const STYLE = "style-marker-s4";
const REGISTER = "register-marker-s4";
const VISION = "vision-marker-s4";
const BOARD = "board-body-marker-s4";
const RULE = "seat-rule-marker-s4";
const [, FRAME = "", CUE = ""] = readFileSync(`${PACKAGE}templates/capability.md`, "utf8").split(/\s*## \w+\s*|\s+$/);

let p: Plant;
let parent = "";
let first = "";
let second = "";
before(async () => {
	p = await plant();
	const files: Record<string, string> = {
		".agents/limen/styleguide.md": `# Styleguide\n\n${STYLE}\n`,
		".agents/limen/communication.md": `# Communication\n\n${REGISTER}\n`,
		"spec/vision.md": `# Vision\n\n${VISION}\n`,
		"spec/build.md": `# Build\n\n## NOW\n\n- ${BOARD}\n`,
		// Copies an old `limen init` planted next to the stub; vanilla Pi loads every .ts in these folders.
		".pi/extensions/limen-communication.ts": `export { default } from ${JSON.stringify(join(PACKAGE, "hook/communication.ts"))};\n`,
		".omp/extensions/limen-steering.ts": `export { default } from ${JSON.stringify(join(PACKAGE, "hook/steering.ts"))};\n`,
	};
	for (const [path, text] of Object.entries(files)) {
		writeFileSync(join(p.root, path), text);
	}
	const rule = { name: "s4", text: RULE, until: "2999-01-01T00:00:00Z", setBy: "", setAt: "", version: "1" };
	mkdirSync(join(p.parent, ".limen/rules/s4"), { recursive: true });
	writeFileSync(join(p.parent, ".limen/rules/s4/rule.json"), JSON.stringify(rule));
	git(p.root, "add", "-A");
	git(p.root, "commit", "-q", "-m", "project guidance and old hook copies");
	first = join(p.parent, "first.ts");
	second = join(p.parent, "second.ts");
	for (const path of [first, second]) {
		writeFileSync(path, "export default () => {};\n");
	}
});
after(() => p.cleanup());

const count = (text: string, marker: string) => text.split(marker).length - 1;
const steers = (dir: string) => engineEvents(dir).flatMap((entry) => (entry.event === "steer" ? [entry.text] : []));
const argv = (id: string): string[] => JSON.parse(jobFile(p, id, "fake-argv.json"));
const extensions = (id: string) =>
	argv(id).flatMap((value, index, all) => (value === "--extension" ? [all[index + 1] ?? ""] : []));

test("a second init removes old hook copies, so a coordinator gets each guidance source once", async () => {
	const init = limen(p, ["init"]);
	assert.equal(init.status, 0, init.stderr);
	// A coordinator Pi in the project loads every .ts in .pi/extensions; the stub then loads the package hooks.
	const coord = join(p.parent, "coord");
	mkdirSync(coord);
	writeFileSync(join(coord, "task.md"), "say hi\n");
	const loaded = readdirSync(join(p.root, ".pi/extensions")).flatMap((name) => [
		"--extension",
		join(p.root, ".pi/extensions", name),
	]);
	const child = spawn(
		join(p.bin, "pi"),
		["--session-dir", join(coord, "session"), ...loaded, `@${join(coord, "task.md")}`],
		{ cwd: p.root, env: { ...p.env, LIMEN_PACKAGE: PACKAGE }, stdio: "ignore" },
	);
	const { promise, resolve } = Promise.withResolvers<number | null>();
	child.once("exit", resolve);
	assert.equal(await promise, 0);
	const system = readFileSync(join(coord, "fake-system.txt"), "utf8");
	const seen = [STYLE, REGISTER, VISION, BOARD, FRAME].map((marker) => count(system, marker));
	assert.deepEqual(seen, [1, 1, 1, 1, 1], "styleguide, register, vision, board, capability frame");
	assert.equal(count(readFileSync(join(coord, "fake-context.txt"), "utf8"), RULE), 1, "a seat rule rides the turn");
	assert.deepEqual(readdirSync(join(p.root, ".pi/extensions")), ["limen.ts"]);
	assert.deepEqual(readdirSync(join(p.root, ".omp/extensions")), ["limen.ts"]);
});

test("a running worker gets each steer once and in order; an ended one refuses a late steer and writes nothing", async () => {
	parent = spawnJob(p, "block", [...FLAGS, "--extension", first, "--priority", "3"]);
	const dir = jobDir(p, parent);
	await until(dir, () => existsSync(join(dir, "fake-blocked-1")));
	for (const [index, text] of ["one", "two"].entries()) {
		assert.equal(limen(p, ["steer", parent, text]).status, 0);
		// The hook has taken the file: a delivery (right or wrong) arrived, or the inbox emptied without one.
		await until(dir, () => steers(dir).length > index || readdirSync(join(dir, "steer/inbox")).length === 0);
	}
	await release(dir);
	assert.equal(waitJob(p, parent), "done");
	// The engine has exited, so every delivery it will ever get is recorded; each asks to log a change in the note.
	const note = new RegExp(`\\n\\n\\[limen\\] If this steer changes .* in \\S+/jobs/${parent}/note\\.md\\. .*$`);
	const delivered = steers(dir).map((text) => text?.replace(note, " +note"));
	assert.deepEqual(delivered, ["one +note", "two +note"]);
	const before = readdirSync(join(dir, "steer"), { recursive: true }).sort();
	const late = limen(p, ["steer", parent, "late"]);
	assert.equal(late.status, 1);
	assert.deepEqual(readdirSync(join(dir, "steer"), { recursive: true }).sort(), before);
});

test("a worker prompt carries register and styleguide once, vision and board pointers, and no board body", () => {
	const system = jobFile(p, parent, "fake-system.txt");
	const context = jobFile(p, parent, "fake-context.txt");
	const seen = [STYLE, REGISTER, FRAME].map((marker) => count(system, marker));
	assert.deepEqual([...seen, count(context, CUE)], [1, 1, 1, 1], "styleguide, register, capability frame and cue");
	assert.ok(context.includes("`spec/vision.md`"), "vision pointer");
	assert.ok(context.includes("`spec/build.md`"), "board pointer");
	const absent = [VISION, BOARD, RULE].map((marker) => count(system + context, marker));
	assert.deepEqual(absent, [0, 0, 0], "a worker reads the vision itself, never gets the board body or a seat rule");
});

test("continue resumes the parent's session, linked, with its extensions or a replacement", () => {
	const parentRecord = jobFile(p, parent, "extensions.json");
	const transcript = readFileSync(join(jobDir(p, parent), "session/fake.jsonl"), "utf8");
	const continued = (flags: readonly string[], from = parent) => {
		const run = limen(p, ["continue", from, "say next", "--detached", ...flags]);
		assert.equal(run.status, 0, run.stderr);
		const id = run.stdout.trim().split("\n").at(-1) ?? "";
		assert.equal(waitJob(p, id), "done");
		return id;
	};
	writeFileSync(join(jobDir(p, parent), "note.md"), "- Done means: now.\n");
	const inherited = continued([]);
	assert.equal(jobFile(p, inherited, "parent"), parent);
	// The child carries the task note, and its first prompt names the note in its own folder.
	assert.equal(jobFile(p, inherited, "note.md"), "- Done means: now.");
	assert.ok(jobFile(p, inherited, "fake-context.txt").includes(`/jobs/${inherited}/note.md, or write it`));
	const resumed = readFileSync(join(jobDir(p, inherited), "session/fake.jsonl"), "utf8");
	assert.ok(resumed.startsWith(transcript) && resumed.length > transcript.length, "the child's transcript grows");
	assert.deepEqual(extensions(inherited).slice(-1), [first]);
	const replaced = continued(["--extension", second, "--timeout", "10m", "--priority", "1"]);
	assert.deepEqual(extensions(replaced).slice(-1), [second]);
	assert.equal([parent, inherited, replaced].map((id) => jobFile(p, id, "priority")).join(), "3,3,1");
	assert.equal(extensions(replaced).includes(first), false);
	assert.equal(jobFile(p, parent, "extensions.json"), parentRecord);
	// --no-builtin-tools: a continuation adds it; no later extension or model choice removes it.
	const guarded = continued(["--no-builtin-tools"], replaced);
	const kept = continued(["--extension", first, "--model", "fixture/other"], guarded);
	const policy = (id: string) => `${jobFile(p, id, "tool-policy")} ${argv(id).includes("--no-builtin-tools")}`;
	const chain = [parent, inherited, replaced, guarded, kept].map(policy).join();
	assert.equal(chain, " false, false, false,no-builtin-tools true,no-builtin-tools true");
	assert.deepEqual([extensions(kept).at(-1), argv(kept)[argv(kept).indexOf("--model") + 1]], [first, "fixture/other"]);
	writeFileSync(join(jobDir(p, kept), "tool-policy"), "builtin\n");
	assert.match(limen(p, ["continue", kept, "say never", "--detached"]).stderr, /invalid .*tool-policy/);
});

test("a broken tool-policy link is not a missing file: detached launch and continue fail before Pi", () => {
	const broken = 'ln -sfn missing "$LIMEN_JOB_DIR/tool-policy"';
	const id = spawnJob(p, "say never", [...FLAGS, "--no-builtin-tools", "--prepare", broken]);
	assert.equal(waitJob(p, id), "failed");
	assert.equal(existsSync(join(jobDir(p, id), "fake-argv.json")), false, "Pi never started");
	assert.match(jobFile(p, id, "log"), /policy link is broken/);
	const finished = spawnJob(p, "say hi", [...FLAGS, "--no-builtin-tools"]);
	assert.equal(waitJob(p, finished), "done");
	const jobs = readdirSync(join(p.root, ".limen/jobs")).length;
	unlinkSync(join(jobDir(p, finished), "tool-policy"));
	symlinkSync("missing", join(jobDir(p, finished), "tool-policy"));
	const continued = limen(p, ["continue", finished, "say never", "--detached"]);
	assert.match(`${continued.status} ${continued.stderr}`, /1 .*policy link is broken/s);
	assert.equal(readdirSync(join(p.root, ".limen/jobs")).length, jobs, "continue published no job");
	const legacy = spawnJob(p, "say hi", FLAGS);
	assert.equal(waitJob(p, legacy), "done");
	assert.equal(existsSync(join(jobDir(p, legacy), "tool-policy")), false);
	assert.equal(argv(legacy).includes("--no-builtin-tools"), false);
});

test("a present tool-policy entry that cannot be read is an error; no entry is legacy", async () => {
	const dir = mkdtempSync(join(tmpdir(), "limen-policy-"));
	const record = join(dir, "tool-policy");
	assert.equal(await readToolPolicy(dir, "pi"), false, "no directory entry");
	symlinkSync("missing", record);
	await assert.rejects(readToolPolicy(dir, "pi"), /policy link is broken/);
	unlinkSync(record);
	symlinkSync("tool-policy", record);
	await assert.rejects(readToolPolicy(dir, "pi"), /ELOOP/);
	unlinkSync(record);
	mkdirSync(record);
	await assert.rejects(readToolPolicy(dir, "pi"), /EISDIR/);
	rmSync(record, { recursive: true });
	writeFileSync(record, "no-builtin-tools\n", { mode: 0 });
	await assert.rejects(readToolPolicy(dir, "pi"), /EACCES/);
	unlinkSync(record);
	writeFileSync(record, "off\n");
	await assert.rejects(readToolPolicy(dir, "pi"), /expected the line/);
	writeFileSync(record, "no-builtin-tools\n");
	await assert.rejects(readToolPolicy(dir, "omp"), /only for Pi/);
	assert.equal(await readToolPolicy(dir, "pi"), true);
	rmSync(dir, { recursive: true });
});
