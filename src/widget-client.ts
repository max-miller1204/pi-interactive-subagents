import { connect } from "node:net";
import { processAlive } from "./process.ts";
import type { RunBackend } from "./run-backend.ts";

export type WidgetBackend = Extract<RunBackend, { kind: "widget" }>;

export interface WidgetStatus {
	childAlive: boolean;
	exitCode: number | null;
	signal: string | null;
}

export interface WidgetClient {
	status(): Promise<WidgetStatus>;
	stop(): Promise<void>;
}

type Request = "status" | "stop";

export async function connectSupervisor(
	backend: WidgetBackend,
	runId: string,
	ownerKey: string,
): Promise<WidgetClient> {
	if (!processAlive(backend.supervisor))
		throw new Error(
			"Widget supervisor identity does not match the live process.",
		);
	if (!processAlive(backend.child))
		throw new Error("Widget child identity does not match the live process.");
	const request = async (command: Request): Promise<WidgetStatus> => {
		if (!processAlive(backend.supervisor))
			throw new Error("Widget supervisor identity changed.");
		if (!processAlive(backend.child))
			throw new Error("Widget child identity changed.");
		return await new Promise<WidgetStatus>((resolve, reject) => {
			const socket = connect(backend.socket);
			let data = "";
			let settled = false;
			const timer = setTimeout(
				() => fail(new Error("Widget supervisor timed out.")),
				3000,
			);
			function done(error?: Error, value?: WidgetStatus) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				if (error) reject(error);
				else resolve(value as WidgetStatus);
			}
			function fail(error: Error) {
				done(error);
			}
			socket.on("error", fail);
			socket.on("connect", () => {
				socket.write(
					`${JSON.stringify({ v: 1, command, runId, ownerKey, supervisor: backend.supervisor, child: backend.child })}\n`,
				);
			});
			socket.on("data", (chunk: Buffer) => {
				data += chunk.toString("utf8");
				if (data.length > 4096)
					return fail(new Error("Widget supervisor response is too large."));
				const newline = data.indexOf("\n");
				if (newline < 0) return;
				try {
					const response: unknown = JSON.parse(data.slice(0, newline));
					if (!response || typeof response !== "object" || !("ok" in response))
						throw new Error("Invalid widget response.");
					if (response.ok === false)
						throw new Error(
							String(
								"error" in response ? response.error : "Widget request failed.",
							),
						);
					if (response.ok !== true || !("status" in response))
						throw new Error("Invalid widget response.");
					const status = response.status as WidgetStatus;
					if (
						typeof status.childAlive !== "boolean" ||
						(status.exitCode !== null && !Number.isInteger(status.exitCode)) ||
						(status.signal !== null && typeof status.signal !== "string")
					)
						throw new Error("Invalid widget status.");
					done(undefined, status);
				} catch (error) {
					fail(error as Error);
				}
			});
			socket.on("end", () =>
				fail(new Error("Widget supervisor closed without a response.")),
			);
		});
	};
	await request("status");
	return {
		status: () => request("status"),
		stop: async () => {
			await request("stop");
		},
	};
}
