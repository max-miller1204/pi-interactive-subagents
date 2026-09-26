import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = process.env.WIDGET_TEST_LOG;
if (!log) throw new Error("WIDGET_TEST_LOG is required");
for await (const line of readline.createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	appendFileSync(log, `${JSON.stringify(command)}\n`);
	if (command.type === "prompt") {
		if (process.env.WIDGET_TEST_MALFORMED === "1")
			process.stdout.write("not-json\n");
		process.stdout.write(
			`${JSON.stringify({ type: "response", command: "prompt", id: command.id, success: true })}\n`,
		);
		if (process.env.WIDGET_TEST_CRASH === "1") process.exit(42);
	}
}
