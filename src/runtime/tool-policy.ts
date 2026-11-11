import { readFile } from "node:fs/promises";
import type { EngineId } from "./engine.ts";

/**
 * The opt-in per-job tool policy. `no-builtin-tools` starts every Pi launch of the job with `--no-builtin-tools`, so Pi
 * activates no built-in tool (read, bash, edit, write, …) and restores none from the transcript; extension tools such
 * as `finish` stay. The record is the job file `tool-policy`. A missing file is a legacy job with Pi's default tools.
 */
export const NO_BUILTIN_TOOLS = "no-builtin-tools";

export function checkToolPolicy(protect: boolean, engine: EngineId): void {
	if (protect && engine !== "pi") {
		throw new Error("--no-builtin-tools is supported only for Pi jobs; use --engine pi");
	}
}

/** True for a protected job. Any other content than the one policy word, or an unreadable file, is an error. */
export async function readToolPolicy(jobDir: string, engine: EngineId): Promise<boolean> {
	const record = `${jobDir}/tool-policy`;
	let body: string;
	try {
		body = await readFile(record, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw new Error(`cannot read ${record}: ${String(error)}`);
	}
	if (body !== `${NO_BUILTIN_TOOLS}\n`) {
		throw new Error(`invalid ${record}: expected the line ${NO_BUILTIN_TOOLS}`);
	}
	checkToolPolicy(true, engine);
	return true;
}
