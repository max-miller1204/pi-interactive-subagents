import childProcess from "node:child_process";
import type { ProcessIdentity } from "./schema.ts";

export function processIdentity(pid: number): ProcessIdentity | null {
	if (!Number.isSafeInteger(pid) || pid < 1) {
		throw new Error(`Invalid pid: ${pid}.`);
	}
	let output: string;
	try {
		output = childProcess.execFileSync(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{
				env: { ...process.env, LC_ALL: "C" },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		const failure = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		if (
			failure.status === 1 &&
			failure.stdout === "" &&
			failure.stderr === ""
		) {
			return null;
		}
		throw new Error(
			`ps failed for pid ${pid}: ${failure.stderr === undefined ? String(error) : failure.stderr}`,
			{ cause: error },
		);
	}
	const start = output.trim();
	if (
		!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(?:[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/.test(
			start,
		)
	) {
		throw new Error(
			`ps returned malformed output for pid ${pid}: ${JSON.stringify(output)}`,
		);
	}
	return { pid, start };
}

export function processAlive(identity: ProcessIdentity): boolean {
	const current = processIdentity(identity.pid);
	return (
		current !== null &&
		current.pid === identity.pid &&
		current.start === identity.start
	);
}
