import { Input, matchesKey, sliceWithWidth, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@oh-my-pi/pi-tui';
import type { Component, TUI } from '@oh-my-pi/pi-tui';
import type { Theme } from '@oh-my-pi/pi-coding-agent';
import { cleanText, describeTarget, detailText, elapsed, outcome, record } from './history';
import type { ActivityCall, ActivityHistory, ActivityState } from './history';

const STATE_LABELS: Record<ActivityState, string> = {
	running: 'Running',
	background: 'Background',
	done: 'Done',
	failed: 'Failed',
	canceled: 'Canceled',
	interrupted: 'Interrupted'
};

const AGENT_STATE_LABELS = new Map([
	['pending', 'Pending'],
	['running', 'Running'],
	['completed', 'Done'],
	['failed', 'Failed'],
	['aborted', 'Canceled'],
	['cancelled', 'Canceled'],
	['canceled', 'Canceled']
]);

function isLive(call: ActivityCall) {
	return call.state === 'running' || call.state === 'background';
}

function stateText(call: ActivityCall, theme: Theme, label = STATE_LABELS[call.state]) {
	if (call.state === 'failed') {
		return theme.fg('error', label);
	}

	if (isLive(call)) {
		return theme.fg('accent', label);
	}

	if (call.state === 'canceled' || call.state === 'interrupted') {
		return theme.fg('warning', label);
	}

	return theme.fg('success', label);
}

function rowLabel(call: ActivityCall) {
	return `${cleanText(call.tool)}  ${describeTarget(call.args)}`;
}

function rowStatus(call: ActivityCall) {
	const result = outcome(call);
	if (result) {
		return `${STATE_LABELS[call.state]} ${result}`;
	}

	return STATE_LABELS[call.state];
}

function rowText(call: ActivityCall) {
	return `${rowLabel(call)}  ${rowStatus(call)}`;
}

class ActivityViewer implements Component {
	#history: ActivityHistory;
	#tui: TUI;
	readonly #theme: Theme;
	readonly #done: () => void;
	#selectedId?: string;
	#details = false;
	#offset = 0;
	#pageSize = 1;
	#detailCache?: readonly string[];
	#detailStarts: number[] = [];
	#cacheText?: string;
	#cacheCall?: ActivityCall;
	#cacheResult?: unknown;
	#cacheDelivery?: unknown;
	#cacheWidth = 0;
	#searchInput?: Input;
	#pattern?: RegExp;
	#direction = 1;
	#searchStatus = '';
	#detailMatch?: number;

	constructor(history: ActivityHistory, tui: TUI, theme: Theme, done: () => void) {
		this.#history = history;
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
		this.#selectedId = history.calls.at(-1)?.id;
	}

	close() {
		this.#done();
	}

	invalidate() {
		this.#detailCache = undefined;
	}

	#selectedIndex() {
		const index = this.#history.calls.findIndex(call => call.id === this.#selectedId);
		if (index < 0) {
			return Math.max(0, this.#history.calls.length - 1);
		}

		return index;
	}

	#detailLines(width: number) {
		const selected = this.#history.calls[this.#selectedIndex()];
		if (!selected) {
			return [];
		}

		if (!this.#detailCache || this.#cacheCall !== selected || this.#cacheResult !== selected.result || this.#cacheDelivery !== selected.delivery || this.#cacheWidth !== width) {
			const text = detailText(selected);
			if (this.#cacheCall !== selected || this.#cacheText !== text) {
				this.#detailMatch = undefined;
			}

			this.#cacheText = text;
			this.#detailCache = wrapTextWithAnsi(text, width);

			// Wrapped plain-text rows map back to source offsets so a search cursor survives reflow.
			this.#detailStarts = [];
			let sourceOffset = 0;

			for (const line of this.#detailCache) {
				const start = text.indexOf(line, sourceOffset);
				this.#detailStarts.push(start);
				sourceOffset = start + line.length;
				if (text[sourceOffset] === '\n') {
					sourceOffset++;
				}
			}

			const matchOffset = this.#detailMatch;
			if (matchOffset !== undefined) {
				this.#offset = this.#detailStarts.findLastIndex(start => start <= matchOffset);
			}

			this.#cacheCall = selected;
			this.#cacheResult = selected.result;
			this.#cacheDelivery = selected.delivery;
			this.#cacheWidth = width;
		}

		return this.#detailCache;
	}

	#highlight(text: string, source = text, offset = 0) {
		if (!this.#pattern) {
			return text;
		}

		this.#pattern.lastIndex = 0;
		let rendered = '';
		let cursor = 0;
		for (const match of source.matchAll(this.#pattern)) {
			const start = Math.max(0, match.index - offset);
			const end = Math.min(text.length, match.index + match[0].length - offset);
			if (end <= start) {
				continue;
			}

			rendered += text.slice(cursor, start);
			rendered += this.#theme.inverse(text.slice(start, end));
			cursor = end;
		}

		return rendered + text.slice(cursor);
	}

	#matches(text: string) {
		if (!this.#pattern) {
			return undefined;
		}

		this.#pattern.lastIndex = 0;
		return this.#pattern.exec(text);
	}

	#find(direction: number) {
		if (!this.#pattern) {
			this.#searchStatus = 'No previous pattern';
			return;
		}

		this.#searchStatus = '';
		if (this.#details) {
			const lines = this.#detailLines(this.#cacheWidth || Math.max(1, this.#tui.terminal.columns - 6));
			let cursor = this.#offset;
			const matchOffset = this.#detailMatch;
			if (matchOffset !== undefined) {
				cursor = this.#detailStarts.findLastIndex(start => start <= matchOffset);
			}

			for (let index = cursor + direction; index >= 0 && index < lines.length; index += direction) {
				const match = this.#matches(lines[index]!);
				if (match) {
					this.#detailMatch = this.#detailStarts[index]! + match.index;
					this.#offset = index;
					return;
				}
			}
		} else {
			const calls = this.#history.calls;
			for (let index = this.#selectedIndex() + direction; index >= 0 && index < calls.length; index += direction) {
				const call = calls[index]!;
				if (this.#matches(rowText(call))) {
					this.#selectedId = call.id;
					return;
				}
			}
		}

		this.#searchStatus = 'Pattern not found';
	}

	#beginSearch(direction: number) {
		const input = new Input();
		input.prompt = '/';
		if (direction < 0) {
			input.prompt = '?';
		}

		input.focused = true;
		input.onEscape = () => {
			this.#searchInput = undefined;
		};

		input.onSubmit = value => {
			if (value) {
				try {
					this.#pattern = new RegExp(value, 'g');
					this.#detailMatch = undefined;
				} catch {
					this.#searchStatus = 'Invalid pattern';
					this.#searchInput = undefined;
					return;
				}
			}

			this.#direction = direction;
			this.#searchInput = undefined;
			this.#find(direction);
		};

		this.#searchStatus = '';
		this.#searchInput = input;
	}

	handleInput(data: string) {
		if (this.#searchInput) {
			if (matchesKey(data, 'ctrl+c')) {
				this.#searchInput = undefined;
			} else {
				this.#searchInput.handleInput(data);
			}

			this.#tui.requestRender();
			return;
		}

		if (matchesKey(data, '/') || matchesKey(data, '?')) {
			let direction = 1;
			if (matchesKey(data, '?')) {
				direction = -1;
			}

			this.#beginSearch(direction);
			this.#tui.requestRender();
			return;
		}

		if (matchesKey(data, 'n') || matchesKey(data, 'shift+n')) {
			let direction = this.#direction;
			if (matchesKey(data, 'shift+n')) {
				direction = -direction;
			}

			this.#find(direction);
			this.#tui.requestRender();
			return;
		}

		this.#searchStatus = '';
		this.#detailMatch = undefined;
		if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c') || matchesKey(data, 'q')) {
			if (this.#details) {
				this.#details = false;
				this.#offset = 0;
			} else {
				this.close();
				return;
			}
		} else if (matchesKey(data, 'enter') && this.#history.calls.length) {
			this.#details = !this.#details;
			this.#offset = 0;
		} else {
			let delta = 0;
			if (matchesKey(data, 'up')) {
				delta = -1;
			} else if (matchesKey(data, 'down')) {
				delta = 1;
			} else if (matchesKey(data, 'pageUp')) {
				delta = -this.#pageSize;
			} else if (matchesKey(data, 'pageDown')) {
				delta = this.#pageSize;
			} else if (matchesKey(data, 'home') || matchesKey(data, 'g')) {
				delta = -Number.MAX_SAFE_INTEGER;
			} else if (matchesKey(data, 'end') || matchesKey(data, 'shift+g')) {
				delta = Number.MAX_SAFE_INTEGER;
			}

			if (this.#details) {
				this.#offset = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, this.#offset + delta));
			} else {
				const index = Math.max(0, Math.min(this.#history.calls.length - 1, this.#selectedIndex() + delta));
				this.#selectedId = this.#history.calls[index]?.id;
			}
		}

		this.#tui.requestRender();
	}

	#callLine(call: ActivityCall, width: number, now: number, selected: boolean) {
		const labelText = rowLabel(call);
		const source = rowText(call);
		const toolWidth = visibleWidth(cleanText(call.tool));
		const metadataWidth = Math.max(0, width - toolWidth - 3);
		let statusLabel = rowStatus(call);
		if (visibleWidth(statusLabel) > metadataWidth) {
			statusLabel = STATE_LABELS[call.state];
		}

		let status = stateText(call, this.#theme, this.#highlight(statusLabel, source, labelText.length + 2));
		if (selected) {
			status = this.#theme.bold(status);
		}

		if (width >= 40) {
			const duration = `  ${elapsed(call, now)}`;
			if (visibleWidth(status) + visibleWidth(duration) <= metadataWidth) {
				status += this.#theme.fg('dim', duration);
			}
		}

		status = truncateToWidth(status, metadataWidth);

		let marker = '▸ ';
		if (selected && this.#details) {
			marker = '▾ ';
		}

		let prefix = this.#theme.fg('dim', marker);
		if (selected) {
			prefix = this.#theme.fg('accent', marker);
		}

		const available = Math.max(0, width - visibleWidth(status) - 3);
		let start = 0;
		const match = this.#matches(source);
		if (selected && match && match.index < labelText.length && visibleWidth(labelText.slice(0, match.index + match[0].length)) > available) {
			start = match.index;
		}

		const visibleLabel = sliceWithWidth(labelText.slice(start), 0, available, true).text;
		const label = `${prefix}${this.#highlight(visibleLabel, source, start)}`;
		let row = `${label}${' '.repeat(Math.max(1, width - visibleWidth(label) - visibleWidth(status)))}${status}`;

		if (selected) {
			row = this.#theme.bg('selectedBg', row);
		}

		return row;
	}

	render(width: number) {
		const height = Math.max(4, this.#tui.terminal.rows);
		const inner = Math.max(1, width - 2);
		const calls = this.#history.calls;
		const selectedIndex = this.#selectedIndex();
		const selected = calls[selectedIndex];
		if (selected && this.#selectedId === undefined) {
			this.#selectedId = selected.id;
		}

		const heading = this.#theme.fg('accent', this.#theme.bold('Activity history'));
		const lines = [heading];
		let action = '↑↓ Select · Enter Expand · Esc/q Close';
		if (this.#details) {
			action = '↑↓ Scroll · Enter/Esc/q Collapse';
		}

		let help = [
			...wrapTextWithAnsi(`${action} · PgUp/PgDn`, inner),
			...wrapTextWithAnsi('Home/g Top · End/G Bottom · /? Search · n/N Repeat', inner)
		];

		const footerBudget = Math.max(1, height - 4);
		if (help.length > footerBudget) {
			help = wrapTextWithAnsi('↑↓ PgUp/PgDn · Home/g End/G · Enter/q/Esc · /? n/N', inner);
		}

		if (help.length > footerBudget) {
			help = wrapTextWithAnsi('q/Esc Back · /? n/N', inner).slice(0, footerBudget);
		}

		const showSummary = height >= 5;
		let bodyBudget = height - 2 - help.length;
		if (showSummary) {
			bodyBudget--;
		}

		this.#pageSize = Math.max(1, bodyBudget);
		let summary = `Call ${selectedIndex + 1} / ${calls.length}`;
		if (!selected) {
			lines.push('No tool calls recorded on this branch.');
			summary = '';
		} else {
			let contextRows = this.#pageSize;
			if (this.#details) {
				contextRows = Math.min(3, calls.length, Math.max(1, Math.floor(bodyBudget / 3)));
				this.#pageSize = Math.max(1, bodyBudget - contextRows);
			}

			let start = Math.max(0, Math.min(selectedIndex - contextRows + 1, calls.length - contextRows));
			if (this.#details) {
				const preceding = Math.min(1, contextRows - 1);
				start = Math.max(0, Math.min(selectedIndex - preceding, calls.length - contextRows));
			}

			const now = Date.now();
			for (let index = start; index < Math.min(calls.length, start + contextRows); index++) {
				const call = calls[index]!;
				lines.push(this.#callLine(call, inner, now, call.id === selected.id));
				if (call.id !== selected.id || !this.#details || bodyBudget <= contextRows) {
					continue;
				}

				const detailLines = this.#detailLines(Math.max(1, inner - 4));
				this.#offset = Math.min(this.#offset, Math.max(0, detailLines.length - this.#pageSize));
				const end = Math.min(this.#offset + this.#pageSize, detailLines.length);
				for (let detail = this.#offset; detail < end; detail++) {
					let branch = '  │ ';
					if (detail === detailLines.length - 1) {
						branch = '  └ ';
					}

					lines.push(`${this.#theme.fg('dim', branch)}${this.#highlight(detailLines[detail]!)}`);
				}

				summary += ` · Lines ${this.#offset + 1}–${end} / ${detailLines.length}`;
			}
		}

		if (showSummary) {
			lines.push(this.#theme.fg('dim', summary));
		}

		while (lines.length < height - 1 - help.length) {
			lines.push('');
		}

		if (this.#searchInput) {
			lines.push(...this.#searchInput.render(inner).slice(0, 1));
		} else {
			let status = this.#searchStatus;
			if (!status && this.#pattern) {
				let prefix = '/';
				if (this.#direction < 0) {
					prefix = '?';
				}

				status = `${prefix}${this.#pattern.source}`;
			}

			lines.push(this.#theme.fg('dim', status));
		}

		lines.push(...help.map(line => this.#theme.fg('dim', line)));

		return lines.map(line => truncateToWidth(line, inner));
	}
}

function progressText(value: unknown) {
	if (typeof value !== 'string') {
		return '';
	}

	return cleanText(value).replace(/\s+/g, ' ').trim();
}

/** Terminal job snapshots supersede stale active rows, but active snapshots cannot revive terminal progress. */
function taskAgentProgress(call: ActivityCall, value: unknown) {
	const agent = record(value);
	if (typeof agent.id !== 'string' || (agent.status !== 'running' && agent.status !== 'pending')) {
		return agent;
	}

	const status = call.jobTimings?.[agent.id]?.status;
	if (status === undefined || status === 'running' || status === 'pending' || !AGENT_STATE_LABELS.has(status)) {
		return agent;
	}

	return { ...agent, status };
}

function taskProgress(call: ActivityCall) {
	if (call.tool !== 'task') {
		return [];
	}

	const progress = record(record(call.result).details).progress;
	if (!Array.isArray(progress)) {
		return [];
	}

	const agents = progress.map(value => taskAgentProgress(call, value)).filter(agent => typeof agent.status === 'string' && AGENT_STATE_LABELS.has(agent.status) && (progressText(agent.id) || progressText(agent.agent)));
	const active = agents.filter(agent => agent.status === 'running' || agent.status === 'pending');
	if (active.length) {
		return active;
	}

	return agents;
}

function alignedText(label: string, metadata: string, width: number) {
	const available = Math.max(0, width - visibleWidth(metadata) - 1);
	if (available === 0) {
		return truncateToWidth(metadata, width);
	}

	const left = truncateToWidth(label, available);

	return `${left}${' '.repeat(width - visibleWidth(left) - visibleWidth(metadata))}${metadata}`;
}

function agentActivity(agent: Record<string, unknown>, width: number, theme: Theme) {
	const name = progressText(agent.id) || progressText(agent.agent);
	const state = AGENT_STATE_LABELS.get(String(agent.status))!;
	const tool = progressText(agent.currentTool);
	let label = name;
	if (agent.status === 'running' && tool) {
		label += ` · ${theme.bold(tool)}`;
		const target = progressText(agent.currentToolArgs) || progressText(agent.currentToolIntent);
		if (target) {
			label += ` ${target}`;
		}
	}

	let status = theme.fg('dim', state);
	if (agent.status === 'running') {
		status = theme.fg('accent', state);
	} else if (agent.status === 'failed') {
		status = theme.fg('error', state);
	} else if (agent.status === 'completed') {
		status = theme.fg('success', state);
	} else if (agent.status !== 'pending') {
		status = theme.fg('warning', state);
	}

	return alignedText(label, status, width);
}

function liveWidget(calls: readonly ActivityCall[], now: number, width: number, theme: Theme) {
	const running = calls.filter(isLive);
	if (!running.length) {
		return undefined;
	}

	if (width < 2) {
		return [];
	}

	const innerWidth = width - 2;

	let heading = ` ${theme.fg('accent', theme.bold('ACTIVITY'))}${theme.fg('dim', ` · ${running.length} active`)}`;
	const hint = theme.fg('dim', '/activities');
	if (visibleWidth(heading) + visibleWidth(hint) + 4 <= innerWidth) {
		heading = alignedText(heading, hint, innerWidth);
	}

	const rows: string[] = [];
	const contentWidth = Math.max(0, innerWidth - 4);
	let rowCount = 0;
	for (const call of running) {
		const agents = taskProgress(call);
		if (agents.length) {
			for (const agent of agents) {
				rowCount++;
				if (rows.length < 3) {
					rows.push(agentActivity(agent, contentWidth, theme));
				}
			}
		} else {
			rowCount++;
			if (rows.length < 3) {
				let metadata = elapsed(call, now);
				if (call.state === 'background') {
					metadata = `${STATE_LABELS[call.state]}  ${metadata}`;
				}

				const label = `${theme.bold(cleanText(call.tool))}  ${describeTarget(call.args)}`;
				rows.push(alignedText(label, theme.fg('dim', metadata), contentWidth));
			}
		}
	}

	if (rowCount > 3) {
		rows.push(theme.fg('dim', `+${rowCount - 3} more`));
	}

	const border = theme.fg('dim', '│');
	const lines = [theme.fg('dim', `╭${'─'.repeat(innerWidth)}╮`)];
	const title = truncateToWidth(heading, innerWidth);
	lines.push(`${border}${title}${' '.repeat(innerWidth - visibleWidth(title))}${border}`);
	for (let index = 0; index < rows.length; index++) {
		let branch = ' ├─ ';
		if (index === rows.length - 1) {
			branch = ' └─ ';
		}

		const row = truncateToWidth(`${theme.fg('dim', branch)}${rows[index]}`, innerWidth);
		lines.push(`${border}${row}${' '.repeat(innerWidth - visibleWidth(row))}${border}`);
	}

	lines.push(theme.fg('dim', `╰${'─'.repeat(innerWidth)}╯`));

	return lines;
}

export { ActivityViewer, isLive, liveWidget };
