// In-memory ring buffer log. Nothing is ever sent over the network; the
// "Export log" command writes the buffer into the vault so it can be read on
// a device without remote web inspector access (iPad from a Linux machine).

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	t: number;
	level: LogLevel;
	scope: string;
	msg: string;
}

const CAPACITY = 1000;
const buffer: LogEntry[] = [];
let head = 0;
let consoleEcho = true;

function push(level: LogLevel, scope: string, parts: unknown[]): void {
	const msg = parts.map(stringify).join(" ");
	const entry: LogEntry = { t: Date.now(), level, scope, msg };
	if (buffer.length < CAPACITY) buffer.push(entry);
	else {
		buffer[head] = entry;
		head = (head + 1) % CAPACITY;
	}
	if (consoleEcho && (level === "warn" || level === "error")) {
		const fn = level === "warn" ? console.warn : console.error;
		fn(`[PDF+++:${scope}]`, msg);
	} else if (consoleEcho && level === "info") {
		console.debug(`[PDF+++:${scope}]`, msg);
	}
}

function stringify(v: unknown): string {
	if (typeof v === "string") return v;
	if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? "\n" + v.stack : ""}`;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

export function logger(scope: string) {
	return {
		debug: (...p: unknown[]) => push("debug", scope, p),
		info: (...p: unknown[]) => push("info", scope, p),
		warn: (...p: unknown[]) => push("warn", scope, p),
		error: (...p: unknown[]) => push("error", scope, p),
	};
}

export function logEntries(): LogEntry[] {
	return buffer.length < CAPACITY ? buffer.slice() : buffer.slice(head).concat(buffer.slice(0, head));
}

export function clearLog(): void {
	buffer.length = 0;
	head = 0;
}

export function setConsoleEcho(on: boolean): void {
	consoleEcho = on;
}

export function formatLog(entries = logEntries()): string {
	return entries
		.map((e) => `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.msg}`)
		.join("\n");
}
