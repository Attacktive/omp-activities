type ActivityState = 'running' | 'background' | 'done' | 'failed' | 'canceled' | 'interrupted';

interface ActivityJobTiming {
	startedAt: number;
	endedAt?: number;
	status: string;
}

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
	jobTimings?: Record<string, ActivityJobTiming>;
}

interface ActivityTiming {
	id: string;
	startedAt?: number;
	endedAt?: number;
	jobStartedAt?: number;
	state: ActivityState;
	jobTimings?: Record<string, ActivityJobTiming>;
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

function cleanTarget(value: unknown) {
	if (typeof value !== 'string' || !value) {
		return '';
	}

	return cleanText(value).replace(/\s+/g, ' ').trim();
}

function describeTasks(tasks: readonly unknown[]) {
	const names: string[] = [];

	for (const raw of tasks) {
		const item = record(raw);
		const label = cleanTarget(item.name) || cleanTarget(item.agent);
		if (label) {
			names.push(label);
		}
	}

	if (names.length) {
		return names.join(', ');
	}

	for (const raw of tasks) {
		const prompt = cleanTarget(record(raw).task);
		if (prompt) {
			return prompt;
		}
	}

	return '';
}

function describeTodo(input: Record<string, unknown>) {
	const op = cleanTarget(input.op);
	if (!op) {
		return '';
	}

	let detail = cleanTarget(input.task) || cleanTarget(input.phase);
	if (!detail && Array.isArray(input.list)) {
		detail = cleanTarget(record(input.list[0]).phase);
	}

	if (!detail && Array.isArray(input.items)) {
		detail = cleanTarget(input.items[0]);
	}

	if (detail) {
		return `${op} ${detail}`;
	}

	return op;
}

function describeQuestions(questions: readonly unknown[]) {
	for (const raw of questions) {
		const item = record(raw);
		const target = cleanTarget(item.header) || cleanTarget(item.question);
		if (target) {
			return target;
		}
	}

	return '';
}

function describeTarget(args: unknown) {
	const input = record(args);

	for (const key of ['path', 'file', 'command', 'query', 'pattern', 'url', 'input', 'title', 'code']) {
		const target = cleanTarget(input[key]);
		if (target) {
			return target;
		}
	}

	if (Array.isArray(input.tasks)) {
		return describeTasks(input.tasks) || cleanTarget(input.i);
	}

	if (Array.isArray(input.questions)) {
		return describeQuestions(input.questions) || cleanTarget(input.i);
	}

	return describeTodo(input) || cleanTarget(input.i);
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

	return call.tool === 'task' && record(details.async).type === 'task' && Array.isArray(details.progress) && details.progress.length > 0;
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

	#retireJob(jobId: string) {
		const call = this.#jobs.get(jobId);
		if (!call) {
			return;
		}

		this.#jobs.delete(jobId);
		for (const tracked of this.#jobs.values()) {
			if (tracked === call) {
				return;
			}
		}

		this.#liveJobs.delete(call);
	}

	/** Receipt commitment can precede message events, so only explicit consumption retires undelivered results. */
	#retireSettledJobs(snapshot: Record<string, unknown>, jobs: ReadonlyMap<unknown, Record<string, unknown>>, consumedResult: unknown) {
		const consumed = record(record(consumedResult).details);
		if ((consumed.op === 'wait' || consumed.op === 'cancel') && Array.isArray(consumed.jobs)) {
			for (const raw of consumed.jobs) {
				const job = record(raw);
				if (typeof job.id === 'string' && (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled')) {
					const call = this.#jobs.get(job.id);
					if (call && (call.state === 'background' || call.state === 'interrupted') && !jobs.has(job.id)) {
						continue;
					}

					this.#retireJob(job.id);
				}
			}
		}

		const pendingJobIds = record(snapshot.delivery).pendingJobIds;
		if (!Array.isArray(pendingJobIds)) {
			return;
		}

		const pending = new Set(pendingJobIds);
		for (const [id, call] of this.#jobs) {
			if (pending.has(id)) {
				continue;
			}

			const job = jobs.get(id);
			if (job?.status === 'running') {
				continue;
			}

			const canceled = job?.status === 'cancelled' && (job.startTime === call.jobStartedAt || job.startTime === call.jobTimings?.[id]?.startedAt);
			const details = record(record(call.result).details);
			const blocking = call.tool === 'task' && !job && id !== record(details.async).jobId && Array.isArray(details.results) && details.results.some(result => record(result).id === id);
			if (canceled || blocking) {
				this.#retireJob(id);
			}
		}
	}

	/** Reconciles each child independently so restored batches retain execution identity and settled siblings. */
	#settleBatch(call: ActivityCall, jobs: ReadonlyMap<unknown, Record<string, unknown>>) {
		if (call.state !== 'background' && call.state !== 'interrupted') {
			return false;
		}

		const progress = record(record(call.result).details).progress as unknown[];
		let state: ActivityState = 'done';
		let endedAt = call.endedAt;
		let running = false;
		let attached = this.#liveJobs.has(call);
		let changed = false;
		for (const raw of progress) {
			const agent = record(raw);
			const id = agent.id;
			if (typeof id !== 'string') {
				continue;
			}

			let timing = call.jobTimings?.[id];
			const job = jobs.get(id);
			if (job && typeof job.startTime === 'number' && typeof job.status === 'string') {
				const sameRun = timing?.startedAt === job.startTime || (timing === undefined && this.#liveJobs.has(call));
				if (sameRun && call.startedAt !== undefined && job.startTime >= call.startedAt) {
					attached = true;
					const endTime = job.endTime;
					if (!timing || timing.status !== job.status || timing.endedAt !== endTime) {
						timing = { startedAt: job.startTime, status: job.status };
						if (typeof endTime === 'number') {
							timing.endedAt = endTime;
						}

						call.jobTimings ??= Object.create(null) as Record<string, ActivityJobTiming>;
						call.jobTimings[id] = timing;
						changed = true;
					}
				} else if (this.#jobs.get(id) === call) {
					this.#retireJob(id);
				}
			}

			const status = timing?.status ?? agent.status;
			if (timing?.endedAt !== undefined) {
				endedAt = Math.max(endedAt ?? 0, timing.endedAt);
			}

			if (status === 'failed') {
				state = 'failed';
			} else if (status === 'aborted' || status === 'cancelled' || status === 'canceled') {
				if (state !== 'failed') {
					state = 'canceled';
				}
			} else if (status !== 'completed') {
				running = true;
			}
		}

		if (!attached) {
			return false;
		}

		this.#liveJobs.add(call);
		if (running) {
			state = 'background';
			endedAt = undefined;
		}

		changed ||= call.state !== state || call.endedAt !== endedAt;
		call.state = state;
		call.endedAt = endedAt;

		return changed;
	}

	/** Uses the host's read-only job snapshot, not tool polling or model turns. */
	syncJobs(snapshot: unknown, consumedResult?: unknown) {
		const jobs = record(snapshot);
		const rows: unknown[] = [];

		if (Array.isArray(jobs.running)) {
			rows.push(...jobs.running);
		}

		if (Array.isArray(jobs.recent)) {
			rows.push(...jobs.recent);
		}

		const byId = new Map(rows.map(job => [record(job).id, record(job)]));
		const consumed = record(record(consumedResult).details);
		if ((consumed.op === 'wait' || consumed.op === 'cancel') && Array.isArray(consumed.jobs)) {
			for (const raw of consumed.jobs) {
				const job = record(raw);
				if (typeof job.id !== 'string' || byId.has(job.id) || (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled')) {
					continue;
				}

				const call = this.#jobs.get(job.id);
				const startTime = call?.jobTimings?.[job.id]?.startedAt ?? call?.jobStartedAt;
				if (startTime === undefined) {
					continue;
				}

				const recovered: Record<string, unknown> = { id: job.id, status: job.status, startTime };
				if (typeof job.durationMs === 'number' && Number.isFinite(job.durationMs) && job.durationMs >= 0) {
					recovered.endTime = startTime + job.durationMs;
				}

				byId.set(job.id, recovered);
			}
		}

		const changed: ActivityCall[] = [];
		const batches = new Set<ActivityCall>();
		for (const [jobId, call] of this.#jobs) {
			if (isTaskBatch(call)) {
				if (!batches.has(call) && this.#settleBatch(call, byId)) {
					changed.push(call);
				}

				batches.add(call);

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

		this.#retireSettledJobs(jobs, byId, consumedResult);

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

				this.#retireJob(info.jobId);
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

				const jobTimings = record(timing.jobTimings);
				for (const [id, raw] of Object.entries(jobTimings)) {
					const job = record(raw);
					if (typeof job.startedAt !== 'number' || !Number.isFinite(job.startedAt) || typeof job.status !== 'string') {
						continue;
					}

					const restored: ActivityJobTiming = { startedAt: job.startedAt, status: job.status };
					if (typeof job.endedAt === 'number' && Number.isFinite(job.endedAt)) {
						restored.endedAt = job.endedAt;
					}

					call.jobTimings ??= Object.create(null) as Record<string, ActivityJobTiming>;
					call.jobTimings[id] = restored;
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
	return { id: call.id, startedAt: call.startedAt, endedAt: call.endedAt, jobStartedAt: call.jobStartedAt, jobTimings: call.jobTimings, state: call.state };
}

export { ActivityHistory, TIMING_ENTRY, cleanText, describeTarget, detailText, elapsed, outcome, record, timingFor };
export type { ActivityCall, ActivityState, ActivityTiming };
