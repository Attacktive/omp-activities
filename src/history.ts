type ActivityState = 'running' | 'background' | 'done' | 'failed' | 'canceled' | 'interrupted';

interface ActivityCall {
	id: string;
	tool: string;
	args: unknown;
	result?: unknown;
	state: ActivityState;
	delivery?: unknown;
	startedAt?: number;
	endedAt?: number;
	jobStartedAt?: number;
}

interface ActivityTiming {
	id: string;
	startedAt?: number;
	endedAt?: number;
	jobStartedAt?: number;
	state: ActivityState;
}

const TIMING_ENTRY = 'dev.attacktive.activity.timing';

function record(value: unknown) {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	return {};
}

/** Removes untrusted terminal controls while preserving output line structure. */

/* eslint-disable no-control-regex -- deliberate terminal control character and escape sequence stripping */
function cleanText(value: string) {
	return value
		.replace(/(?:\x1b]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g, '')
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
		.replace(/\x1b[ -/]*[@-~]/g, '')
		.replace(/\r/g, ' ')
		.replace(/\t/g, '    ')
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/* eslint-enable no-control-regex */

function describeTarget(args: unknown) {
	const input = record(args);

	for (const key of ['path', 'file', 'command', 'query', 'pattern', 'url', 'input', 'i']) {
		if (typeof input[key] === 'string' && input[key]) {
			return cleanText(input[key]).replace(/\s+/g, ' ').trim();
		}
	}

	return '';
}

function resultState(result: unknown, isError: boolean) {
	const frame = record(result);
	const details = record(frame.details);
	const state = record(details.async).state;
	if (state === 'running') {
		return 'background';
	}

	if (state === 'cancelled' || state === 'canceled' || details.cancelled === true || details.canceled === true) {
		return 'canceled';
	}

	if (state === 'failed' || isError || frame.isError === true) {
		return 'failed';
	}

	return 'done';
}

function outcome(call: ActivityCall) {
	const details = record(record(call.result).details);
	if (typeof details.exitCode === 'number') {
		return `exit ${details.exitCode}`;
	}

	return '';
}

function elapsed(call: ActivityCall, now: number) {
	if (call.startedAt === undefined) {
		return 'unknown';
	}

	let end = call.endedAt;
	if (end === undefined && (call.state === 'running' || call.state === 'background')) {
		end = now;
	}

	if (end === undefined) {
		return 'unknown';
	}

	return `${(Math.max(0, end - call.startedAt) / 1000).toFixed(1)}s`;
}

function isTaskBatch(call: ActivityCall) {
	const details = record(record(call.result).details);

	return call.tool === 'task' && record(details.async).type === 'task' && Array.isArray(details.progress) && details.progress.length > 1;
}

class ActivityHistory {
	readonly calls: ActivityCall[] = [];
	#byId = new Map<string, ActivityCall>();
	#jobs = new Map<string, ActivityCall>();
	#liveJobs = new Set<ActivityCall>();

	start(id: string, tool: string, args: unknown, now: number) {
		const previous = this.#byId.get(id);
		if (previous && (previous.state === 'running' || previous.state === 'background')) {
			return previous;
		}

		const call: ActivityCall = { id, tool, args, state: 'running', startedAt: now };
		this.#byId.set(id, call);
		if (previous) {
			this.#liveJobs.delete(previous);
			for (const [jobId, tracked] of this.#jobs) {
				if (tracked === previous) {
					this.#jobs.delete(jobId);
				}
			}

			this.calls[this.calls.indexOf(previous)] = call;
		} else {
			this.calls.push(call);
		}

		return call;
	}

	update(id: string, result: unknown, now?: number) {
		const call = this.#byId.get(id);
		if (!call) {
			return;
		}

		call.result = result;

		if (isTaskBatch(call) && (call.state === 'background' || call.state === 'interrupted')) {
			const state = resultState(result, false);
			if (state !== call.state) {
				call.state = state;
				if (state !== 'background') {
					call.endedAt = now;
				}

				return call;
			}
		}
	}

	finish(id: string, result: unknown, isError: boolean, now?: number) {
		const call = this.#byId.get(id);
		if (!call) {
			return;
		}

		call.result = result;
		call.state = resultState(result, isError);
		const job = record(record(record(result).details).async);

		if (typeof job.jobId === 'string') {
			this.#jobs.set(job.jobId, call);
			if (call.state === 'background') {
				this.#liveJobs.add(call);
			}

			if (isTaskBatch(call)) {
				const progress = record(record(result).details).progress as unknown[];
				for (const agent of progress) {
					const id = record(agent).id;
					if (typeof id === 'string') {
						this.#jobs.set(id, call);
					}
				}
			}
		}

		if (call.state !== 'background') {
			call.endedAt = now ?? call.endedAt;
		}

		return call;
	}

	cancelRunning(now: number) {
		const canceled: ActivityCall[] = [];

		for (const call of this.calls) {
			if (call.state === 'running') {
				call.state = 'canceled';
				call.endedAt = now;
				canceled.push(call);
			}
		}

		return canceled;
	}

	cancelCalls(ids: ReadonlySet<string>, now: number) {
		const canceled: ActivityCall[] = [];

		for (const id of ids) {
			const call = this.#byId.get(id);
			if (call && (call.state === 'running' || call.state === 'failed')) {
				call.state = 'canceled';
				call.endedAt ??= now;
				canceled.push(call);
			}
		}

		return canceled;
	}

	/** Queued cancellations may settle without another aggregate progress event. */
	#settleBatch(call: ActivityCall, jobs: ReadonlyMap<unknown, Record<string, unknown>>) {
		if (call.state !== 'background' || !this.#liveJobs.has(call)) {
			return false;
		}

		const progress = record(record(call.result).details).progress as unknown[];
		let state: ActivityState = 'done';
		let endedAt = call.endedAt;
		for (const raw of progress) {
			const agent = record(raw);
			let status = agent.status;
			const job = jobs.get(agent.id);
			if (job && typeof job.startTime === 'number' && call.startedAt !== undefined && job.startTime >= call.startedAt) {
				status = job.status;
				if (typeof job.endTime === 'number') {
					endedAt = Math.max(endedAt ?? 0, job.endTime);
				}
			}

			if (status === 'failed') {
				state = 'failed';
			} else if (status === 'aborted' || status === 'cancelled' || status === 'canceled') {
				if (state !== 'failed') {
					state = 'canceled';
				}
			} else if (status !== 'completed') {
				return false;
			}
		}

		call.state = state;
		call.endedAt = endedAt;

		return true;
	}

	/** Uses the host's read-only job snapshot, not tool polling or model turns. */
	syncJobs(snapshot: unknown) {
		const jobs = record(snapshot);
		const rows: unknown[] = [];

		if (Array.isArray(jobs.running)) {
			rows.push(...jobs.running);
		}

		if (Array.isArray(jobs.recent)) {
			rows.push(...jobs.recent);
		}

		if (!rows.length) {
			return [];
		}

		const byId = new Map(rows.map(job => [record(job).id, record(job)]));
		const changed: ActivityCall[] = [];
		for (const [jobId, call] of this.#jobs) {
			if (isTaskBatch(call)) {
				if (this.#settleBatch(call, byId)) {
					changed.push(call);
				}

				continue;
			}

			const job = byId.get(jobId);
			if (!job || (call.state !== 'background' && call.state !== 'interrupted') || typeof job.startTime !== 'number') {
				continue;
			}

			if (!this.#liveJobs.has(call) && call.jobStartedAt !== job.startTime) {
				continue;
			}

			if (call.startedAt !== undefined && job.startTime < call.startedAt) {
				continue;
			}

			const state = resultState({ details: { async: { state: job.status } } }, job.status === 'failed');
			if (state !== call.state || call.jobStartedAt !== job.startTime || (typeof job.endTime === 'number' && call.endedAt !== job.endTime)) {
				call.jobStartedAt = job.startTime;
				call.state = state;
				if (typeof job.endTime === 'number') {
					call.endedAt = job.endTime;
				}

				changed.push(call);
			}
		}

		return changed;
	}

	deliver(message: unknown) {
		const delivery = record(message);
		const jobs = record(delivery.details).jobs;
		if (delivery.customType !== 'async-result' || !Array.isArray(jobs)) {
			return;
		}

		const delivered = new Set<ActivityCall>();
		for (const job of jobs) {
			const info = record(job);
			if (typeof info.jobId !== 'string') {
				continue;
			}

			const call = this.#jobs.get(info.jobId);
			if (!call) {
				continue;
			}

			if (!delivered.has(call)) {
				if (isTaskBatch(call)) {
					const previous = call.delivery;
					const messages: unknown[] = [];
					if (Array.isArray(previous)) {
						messages.push(...previous);
					} else if (previous !== undefined) {
						messages.push(previous);
					}

					messages.push(message);
					call.delivery = messages;
				} else {
					call.delivery = message;
				}

				delivered.add(call);
			}

			if (info.status === 'completed' || info.status === 'failed' || info.status === 'cancelled') {
				if (!isTaskBatch(call)) {
					call.state = resultState({ details: { async: { state: info.status } } }, false);
				}

				this.#jobs.delete(info.jobId);

				let hasRemainingJobs = false;
				for (const tracked of this.#jobs.values()) {
					if (tracked === call) {
						hasRemainingJobs = true;
						break;
					}
				}

				if (!hasRemainingJobs) {
					this.#liveJobs.delete(call);
				}
			}
		}
	}

	/** Reconstructs only the selected branch; old missing results are not live executions. */
	restore(entries: readonly unknown[]) {
		this.calls.length = 0;
		this.#byId.clear();
		this.#jobs.clear();
		this.#liveJobs.clear();

		const timings = new Map<string, ActivityTiming>();
		const boundary = entries.findLastIndex(raw => record(raw).type === 'reset_boundary');

		for (let index = boundary + 1; index < entries.length; index++) {
			const raw = entries[index];
			const entry = record(raw);
			if (entry.type === 'custom' && entry.customType === TIMING_ENTRY) {
				const timing = record(entry.data);
				if (typeof timing.id === 'string') {
					timings.set(timing.id, timing as unknown as ActivityTiming);
				}

				continue;
			}

			if (entry.type === 'custom_message' && entry.customType === 'async-result') {
				this.deliver(entry);
			}

			if (entry.type !== 'message') {
				continue;
			}

			const message = record(entry.message);
			if (message.role === 'assistant' && Array.isArray(message.content)) {
				for (const rawBlock of message.content) {
					const block = record(rawBlock);
					if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
						const call = this.start(block.id, block.name, block.arguments, 0);
						call.startedAt = undefined;
						call.state = 'interrupted';
					}
				}
			} else if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
				if (!this.#byId.has(message.toolCallId)) {
					const call = this.start(message.toolCallId, String(message.toolName ?? 'tool'), undefined, 0);
					call.startedAt = undefined;
				}

				this.finish(message.toolCallId, message, message.isError === true);
			}
		}

		for (const call of this.calls) {
			const timing = timings.get(call.id);
			if (timing) {
				if (typeof timing.startedAt === 'number' && Number.isFinite(timing.startedAt)) {
					call.startedAt = timing.startedAt;
				}

				if (typeof timing.endedAt === 'number' && Number.isFinite(timing.endedAt)) {
					call.endedAt = timing.endedAt;
				}

				if (typeof timing.jobStartedAt === 'number' && Number.isFinite(timing.jobStartedAt)) {
					call.jobStartedAt = timing.jobStartedAt;
				}

				if (timing.state === 'canceled' || (call.endedAt !== undefined && (timing.state === 'done' || timing.state === 'failed'))) {
					call.state = timing.state;
				}
			}

			if (call.state === 'background' || call.state === 'running') {
				call.state = 'interrupted';
			}
		}

		this.#liveJobs.clear();
		for (const [jobId, call] of this.#jobs) {
			if (call.state !== 'interrupted') {
				this.#jobs.delete(jobId);
			}
		}
	}
}

function safeJson(value: unknown) {
	const seen = new WeakSet<object>();

	const serialized = JSON.stringify
	(
		value,
		(_key, item: unknown) => {
			if (typeof item === 'bigint') {
				return String(item);
			}

			if (item && typeof item === 'object') {
				if (seen.has(item)) {
					return '[Repeated object]';
				}

				seen.add(item);

				const image = record(item);
				if (typeof image.data === 'string' && (image.type === 'image' || (typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')))) {
					return { ...image, data: `[${image.data.length} encoded image characters]` };
				}
			}

			return item;
		},
		2
	);

	return serialized ?? '(not recorded)';
}

function resultText(result: unknown) {
	const frame = record(result);
	const sections: string[] = [];

	if (typeof frame.content === 'string') {
		sections.push(frame.content);
	} else if (Array.isArray(frame.content)) {
		for (const raw of frame.content) {
			const block = record(raw);
			if (block.type === 'text' && typeof block.text === 'string') {
				sections.push(block.text);
			} else {
				sections.push(safeJson(block));
			}
		}
	}

	const { content: _content, ...metadata } = frame;
	if (Object.keys(metadata).length) {
		sections.push('Metadata', safeJson(metadata));
	}

	if (!sections.length) {
		return safeJson(result);
	}

	return sections.join('\n\n');
}

function detailText(call: ActivityCall) {
	const sections = ['Arguments', safeJson(call.args), 'Result', resultText(call.result)];
	if (call.delivery !== undefined) {
		sections.push('Background completion', resultText(call.delivery));
	}

	return cleanText(sections.join('\n\n'));
}

function timingFor(call: ActivityCall) {
	return { id: call.id, startedAt: call.startedAt, endedAt: call.endedAt, jobStartedAt: call.jobStartedAt, state: call.state };
}

export { ActivityHistory, TIMING_ENTRY, cleanText, describeTarget, detailText, elapsed, outcome, record, timingFor };
export type { ActivityCall, ActivityState, ActivityTiming };
