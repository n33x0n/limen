import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";

/**
 * A job's view in herdr-core, the daemon behind the Herdr app: one terminal that follows the job log, in the space of
 * the terminal that spawned the job. Legacy `herdr` (HERDR_ENV=1) keeps `herdr.ts`; this file only opens
 * and removes views. Every call here is advisory: a failure is a line in the job log, never a failed job.
 */
export type CoreView = {
	readonly terminal: string;
	readonly space: string;
	readonly socket: string;
	readonly mode: "watch" | "log";
};
const FIELDS = ["terminal", "space", "socket", "mode"] as const;

/** `LIMEN_HERDR_CORE=0` turns herdr-core off; another value must exist; otherwise `herdr-core` on PATH. */
export function coreBinary(): string | undefined {
	const override = process.env.LIMEN_HERDR_CORE?.trim();
	if (override === "0") {
		return;
	}
	if (override) {
		return existsSync(override) ? override : undefined;
	}
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(`${dir}/herdr-core`)) {
			return `${dir}/herdr-core`;
		}
	}
}

/** True inside a herdr-core terminal: its socket and terminal ID are set and the CLI is present. */
export function coreAvailable(): boolean {
	return Boolean(process.env.HC_TERMINAL_SOCKET?.trim() && process.env.HC_TERMINAL_ID?.trim() && coreBinary());
}

/** Open a view that follows the log, in the space of the calling terminal (or the recorded one), and record it. */
export async function openCoreView(input: {
	readonly jobDir: string;
	readonly label: string;
	readonly cwd: string;
	readonly state: string;
	readonly follow: boolean;
}): Promise<CoreView | undefined> {
	const bin = coreBinary();
	if (!bin) {
		await skip(input.jobDir, "herdr-core is not available");
		return;
	}
	try {
		const recorded = await readCoreView(input.jobDir);
		const socket = process.env.HC_TERMINAL_SOCKET?.trim() || recorded?.socket || "";
		const space = coordinatorSpace(bin, socket) || recorded?.space;
		if (!space) {
			throw new Error("the calling terminal has no herdr.space label");
		}
		const id = basename(input.jobDir);
		const labels = { "herdr.space": space, "limen.job": id, "limen.label": input.label, "limen.state": input.state };
		const tail = input.follow ? ["-n", "200", "-F"] : ["-n", "+1", "-F"];
		const started = call(
			bin,
			socket,
			[
				"run",
				"--json",
				"--bg",
				"--outlive-parent",
				"--no-notify",
				"--name",
				viewName(input.label, id),
				"--cwd",
				input.cwd,
				...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
				"--",
				"tail",
				...tail,
				`${input.jobDir}/log`,
			],
			10_000,
		);
		const terminal = started.address;
		if (typeof terminal !== "string" || !terminal) {
			throw new Error("herdr-core run returned no address");
		}
		const view: CoreView = { terminal, space, socket, mode: input.follow ? "watch" : "log" };
		await recordCoreView(input.jobDir, view);
		return view;
	} catch (error) {
		await skip(input.jobDir, message(error));
	}
}

/** `limen open`: say where a live view is (herdr-core has no focus verb), or open a fresh one in place of a dead one. */
export async function reopenCoreView(input: {
	readonly jobDir: string;
	readonly label: string;
	readonly cwd: string;
	readonly running: boolean;
}): Promise<string> {
	const bin = coreBinary();
	if (!bin) {
		throw new Error("herdr-core is not available");
	}
	const recorded = await readCoreView(input.jobDir);
	const row = recorded ? ownedTerminal(bin, recorded, basename(input.jobDir)) : undefined;
	if (row?.state === "live") {
		return `${input.label} is open in herdr-core as ${recorded?.terminal} (${whereOf(row)})`;
	}
	if (recorded && row) {
		call(bin, recorded.socket, ["rm", "--json", recorded.terminal], 5_000);
	}
	const state = (await text(`${input.jobDir}/state`)) || "done";
	const view = await openCoreView({ ...input, state, follow: input.running });
	if (!view) {
		throw new Error(`herdr-core skipped; see ${input.jobDir}/log`);
	}
	return `opened ${input.label} in herdr-core as ${view.terminal}`;
}

/**
 * At finish a detached child closes the view, as the legacy tab closer does,
 * so finalize never waits on herdr-core.
 */
export async function settleCoreView(jobDir: string): Promise<void> {
	const bin = coreBinary();
	if (!(await readCoreView(jobDir))) {
		return;
	}
	if (!bin) {
		return skip(jobDir, "herdr-core is not available; the view stays open");
	}
	const from = JSON.stringify(import.meta.url);
	const close = `import { closeCoreView } from ${from}; await closeCoreView(${JSON.stringify(jobDir)});`;
	try {
		const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", close], {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", (error) => void skip(jobDir, `close could not start: ${error.message}`));
		child.unref();
	} catch (error) {
		await skip(jobDir, message(error));
	}
}

/** End and remove the job's view, then forget it. Returns true when a view this job owns was removed. */
export async function closeCoreView(jobDir: string): Promise<boolean> {
	const view = await readCoreView(jobDir);
	const bin = coreBinary();
	if (!(view && bin)) {
		return false;
	}
	try {
		const row = ownedTerminal(bin, view, basename(jobDir));
		if (row?.state === "live") {
			call(bin, view.socket, ["kill", "--json", view.terminal], 10_000);
		}
		if (row) {
			removeFinished(bin, view);
		}
		await rm(`${jobDir}/herdr-core`, { recursive: true, force: true });
		return Boolean(row);
	} catch (error) {
		await skip(jobDir, message(error));
		return false;
	}
}

export async function readCoreView(jobDir: string): Promise<CoreView | undefined> {
	const [terminal = "", space = "", socket = "", mode] = await Promise.all(
		FIELDS.map((name) => text(`${jobDir}/herdr-core/${name}`)),
	);
	if (!(terminal && space) || (mode !== "watch" && mode !== "log")) {
		return;
	}
	return { terminal, space, socket, mode };
}

async function recordCoreView(jobDir: string, view: CoreView): Promise<void> {
	await mkdir(`${jobDir}/herdr-core`, { recursive: true });
	await Promise.all(FIELDS.map((name) => writeFile(`${jobDir}/herdr-core/${name}`, `${view[name]}\n`)));
}

/** The `herdr.space` label of the terminal that runs this command; the Herdr app files a terminal by it. */
function coordinatorSpace(bin: string, socket: string): string | undefined {
	const caller = process.env.HC_TERMINAL_ID?.trim();
	if (!caller) {
		return;
	}
	const space = asRecord(call(bin, socket, ["get", "--json", caller], 5_000).labels)["herdr.space"];
	return typeof space === "string" && space ? space : undefined;
}

/**
 * The recorded terminal, only while its `limen.job` label names this job; a terminal someone else made is never
 * touched. Undefined when it is gone or not ours.
 */
function ownedTerminal(bin: string, view: CoreView, id: string): Record<string, unknown> | undefined {
	try {
		const row = call(bin, view.socket, ["get", "--json", view.terminal], 5_000);
		return asRecord(row.labels)["limen.job"] === id ? row : undefined;
	} catch {
		return;
	}
}

/** `kill` hangs up and escalates; `rm` takes only a finished terminal, so it retries while the program ends. */
function removeFinished(bin: string, view: CoreView): void {
	for (let attempt = 1; ; attempt += 1) {
		try {
			call(bin, view.socket, ["rm", "--json", view.terminal], 5_000);
			return;
		} catch (error) {
			if (attempt >= 10) {
				throw error;
			}
			spawnSync("sleep", ["0.2"], { stdio: "ignore" });
		}
	}
}

/** A herdr-core name: 1 to 32 of a-z 0-9 - _, unique among live terminals; the job ID's last part keeps it unique. */
function viewName(label: string, id: string): string {
	const suffix =
		(id.split("-").at(-1) || id)
			.toLowerCase()
			.replace(/[^a-z0-9]/g, "")
			.slice(0, 12) || "job";
	const stem = label
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 31 - suffix.length)
		.replace(/-+$/, "");
	return stem && !stem.endsWith(suffix) ? `${stem}-${suffix}` : stem || `limen-${suffix}`;
}

function whereOf(row: Record<string, unknown>): string {
	const where = asRecord(row.labels).where;
	return typeof where === "string" && where ? where : "no place shown yet";
}

function call(bin: string, socket: string, args: readonly string[], timeout = 15_000): Record<string, unknown> {
	const env = socket ? { ...process.env, HC_TERMINAL_SOCKET: socket } : process.env;
	const result = spawnSync(bin, args, { encoding: "utf8", timeout, env });
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`herdr-core ${args[0]}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`}`,
		);
	}
	const parsed = asRecord(JSON.parse(result.stdout || "{}"));
	return asRecord(parsed.result ?? parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function text(path: string): Promise<string> {
	return readFile(path, "utf8").then(
		(value) => value.trim(),
		() => "",
	);
}

function skip(jobDir: string, reason: string): Promise<void> {
	return appendFile(`${jobDir}/log`, `[limen ${new Date().toISOString()}] herdr-core skipped: ${reason}\n`).catch(
		() => {},
	);
}
