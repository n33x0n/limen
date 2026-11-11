import { lstat, readFile } from "node:fs/promises";
import type { EngineId } from "./engine.ts";

/**
 * The opt-in per-job tool policy. `no-builtin-tools` starts every Pi launch of the job with `--no-builtin-tools`, so Pi
 * activates no built-in tool (read, bash, edit, write, …) and restores none from the transcript; extension tools such
 * as `finish` stay. The record is the job file `tool-policy`. No directory entry is a legacy job with Pi's default tools.
 * A broken link is not that absence: reading it also returns ENOENT, and that launch must fail.
 */
export const NO_BUILTIN_TOOLS = "no-builtin-tools";

export function checkToolPolicy(protect: boolean, engine: EngineId): void {
	if (protect && engine !== "pi") {
		throw new Error("--no-builtin-tools is supported only for Pi jobs; use --engine pi");
	}
}

/** True for a protected job. A present entry that cannot be read, including a broken link, is an error. */
export async function readToolPolicy(jobDir: string, engine: EngineId): Promise<boolean> {
	const record = `${jobDir}/tool-policy`;
	const entry = await policyEntry(record);
	if (!entry) {
		return false;
	}
	const body = await policyText(record, entry.isSymbolicLink());
	if (body !== `${NO_BUILTIN_TOOLS}\n`) {
		throw new Error(`invalid ${record}: expected the line ${NO_BUILTIN_TOOLS}`);
	}
	checkToolPolicy(true, engine);
	return true;
}

/** Undefined only when the directory has no `tool-policy` entry. A symlink entry counts as present. */
async function policyEntry(record: string): Promise<{ isSymbolicLink(): boolean } | undefined> {
	try {
		return await lstat(record);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw new Error(`cannot read ${record}: ${String(error)}`);
	}
}

/** The file text. ENOENT after a symlink entry was seen is a broken link, not a legacy record. */
async function policyText(record: string, link: boolean): Promise<string> {
	try {
		return await readFile(record, "utf8");
	} catch (error) {
		if (link && (error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`invalid ${record}: the policy link is broken`);
		}
		throw new Error(`cannot read ${record}: ${String(error)}`);
	}
}
