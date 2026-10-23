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
	['aborted', 'Canceled']
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

function rowText(call: ActivityCall) {
	return `${rowLabel(call)}  ${STATE_LABELS[call.state]}`;
}

class ActivityViewer implements Component {
	#history: ActivityHistory;
	#tui: TUI;
	#theme: Theme;
	#done: () => void;
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
			const lines = this.#detailLines(this.#cacheWidth || Math.max(1, this.#tui.terminal.columns - 2));
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

	render(width: number) {
		const height = Math.max(4, this.#tui.terminal.rows);
		const inner = Math.max(1, width - 2);
		const calls = this.#history.calls;
		const selectedIndex = this.#selectedIndex();
		const selected = calls[selectedIndex];
		if (selected && this.#selectedId === undefined) {
			this.#selectedId = selected.id;
		}

		const heading = this.#theme.fg('accent', this.#theme.bold('Tool history'));
		const lines = [heading, this.#theme.fg('dim', '─'.repeat(inner))];
		let action = '↑↓ Select · Enter Details · Esc/q Close';
		if (this.#details) {
			action = '↑↓ Scroll · Enter/Esc/q Back';
		}

		let help = [
			...wrapTextWithAnsi(`${action} · PgUp/PgDn`, inner),
			...wrapTextWithAnsi('Home/g Top · End/G Bottom · /? Search · n/N Repeat', inner)
		];
		const footerBudget = Math.max(1, height - 6);
		if (help.length > footerBudget) {
			help = wrapTextWithAnsi('↑↓ PgUp/PgDn · Home/g End/G · Enter/q/Esc · /? n/N', inner);
		}

		if (help.length > footerBudget) {
			help = wrapTextWithAnsi('q/Esc Back · /? n/N', inner).slice(0, footerBudget);
		}

		this.#pageSize = Math.max(1, height - 5 - help.length);
		if (!selected) {
			lines.push('No tool calls recorded on this branch.');
		} else if (this.#details) {
			lines.push(`${this.#highlight(cleanText(selected.tool))} · ${stateText(selected, this.#theme, this.#highlight(STATE_LABELS[selected.state]))}`);
			const detailLines = this.#detailLines(inner);
			this.#offset = Math.min(this.#offset, Math.max(0, detailLines.length - this.#pageSize));
			lines.push(...detailLines.slice(this.#offset, this.#offset + this.#pageSize).map(line => this.#highlight(line)));
			lines.push(this.#theme.fg('dim', `Lines ${this.#offset + 1}–${Math.min(this.#offset + this.#pageSize, detailLines.length)} / ${detailLines.length}`));
		} else {
			const start = Math.max(0, Math.min(selectedIndex - this.#pageSize + 1, calls.length - this.#pageSize));
			for (let index = start; index < Math.min(calls.length, start + this.#pageSize); index++) {
				const call = calls[index]!;
				let prefix = '  ';
				if (call.id === selected.id) {
					prefix = this.#theme.fg('accent', '› ');
				}

				const labelText = rowLabel(call);
				const source = rowText(call);
				let status = stateText(call, this.#theme, this.#highlight(STATE_LABELS[call.state], source, labelText.length + 2));
				if (call.id === selected.id) {
					status = this.#theme.bold(status);
				}

				const available = Math.max(1, inner - visibleWidth(status) - 4);
				let start = 0;
				const match = this.#matches(source);
				if (call.id === selected.id && match && match.index < labelText.length && visibleWidth(labelText.slice(0, match.index + match[0].length)) > available) {
					start = match.index;
				}

				const visibleLabel = sliceWithWidth(labelText.slice(start), 0, available).text;
				const label = `${prefix}${this.#highlight(visibleLabel, source, start)}`;
				let row = `${label}${' '.repeat(Math.max(1, inner - visibleWidth(label) - visibleWidth(status)))}${status}`;
				if (call.id === selected.id) {
					row = this.#theme.bg('selectedBg', row);
				}

				lines.push(row);
			}

			const result = outcome(selected);
			let summary = `Call ${selectedIndex + 1} / ${calls.length}`;
			if (result) {
				summary += ` · ${result}`;
			}

			lines.push(this.#theme.fg('dim', summary));
		}

		while (lines.length < height - 1 - help.length) {
			lines.push('');
		}

		if (this.#searchInput) {
			lines.push(...this.#searchInput.render(inner));
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

function taskProgress(call: ActivityCall) {
	if (call.tool !== 'task') {
		return [];
	}

	const progress = record(record(call.result).details).progress;
	if (!Array.isArray(progress)) {
		return [];
	}

	const agents = progress.map(record).filter(agent => typeof agent.status === 'string' && AGENT_STATE_LABELS.has(agent.status) && (progressText(agent.id) || progressText(agent.agent)));
	const active = agents.filter(agent => agent.status === 'running' || agent.status === 'pending');
	if (active.length) {
		return active;
	}

	return agents;
}

function agentActivity(agent: Record<string, unknown>) {
	const name = progressText(agent.id) || progressText(agent.agent);
	const state = AGENT_STATE_LABELS.get(String(agent.status));
	const tool = progressText(agent.currentTool);
	if (agent.status !== 'running' || !tool) {
		return `${name} · ${state}`;
	}

	const target = progressText(agent.currentToolArgs) || progressText(agent.currentToolIntent);
	if (target) {
		return `${name} · ${tool} ${target} · ${state}`;
	}

	return `${name} · ${tool} · ${state}`;
}

function liveWidget(calls: readonly ActivityCall[], now: number) {
	const running = calls.filter(isLive);
	if (!running.length) {
		return undefined;
	}

	const lines = [`Activity · active calls: ${running.length} · /activities`];
	let rowCount = 0;
	for (const call of running) {
		const agents = taskProgress(call);
		if (agents.length) {
			for (const agent of agents) {
				rowCount++;
				if (lines.length <= 3) {
					lines.push(agentActivity(agent));
				}
			}
		} else {
			rowCount++;
			if (lines.length <= 3) {
				lines.push(`${cleanText(call.tool)}  ${describeTarget(call.args)} · ${elapsed(call, now)} · ${STATE_LABELS[call.state]}`);
			}
		}
	}

	if (rowCount > 3) {
		lines.push(`+${rowCount - 3} more`);
	}

	return lines;
}

export { ActivityViewer, isLive, liveWidget };
