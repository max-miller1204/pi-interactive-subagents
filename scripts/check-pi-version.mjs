#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const installed = JSON.parse(
	readFileSync(
		new URL(
			"../node_modules/@earendil-works/pi-coding-agent/package.json",
			import.meta.url,
		),
		"utf8",
	),
).version;
const update = `Install the matching Pi executable: npm install -g @earendil-works/pi-coding-agent@${installed}`;

try {
	const executable = execFileSync("pi", ["--version"], {
		encoding: "utf8",
	}).trim();
	if (executable !== installed) {
		console.error(
			`Pi executable version ${executable} does not match installed version ${installed}. ${update}`,
		);
		process.exitCode = 1;
	}
} catch (error) {
	console.error(`Cannot run pi --version: ${error.message}. ${update}`);
	process.exitCode = 1;
}
