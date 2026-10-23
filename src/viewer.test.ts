import { expect, test } from 'bun:test';
import { visibleWidth } from '@oh-my-pi/pi-tui';
import { ActivityHistory } from './history';
import { ActivityViewer, liveWidget } from './viewer';

const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => `[${text}]` };

interface FixtureEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: unknown;
}

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

interface FixtureCommand {
	handler: CommandHandler;
}

type ViewerFactory = (tui: unknown, theme: unknown, keys: unknown, done: () => void) => InstanceType<typeof ActivityViewer>;

test
(
	'constrains narrow footer and fullscreen height bounds in a 20x10 terminal',
	() => {
		const { viewer } = fixture(10);
		const listLines = viewer.render(20);

		expect(listLines.length)
			.toBe(10);

		for (const line of listLines) {
			expect(visibleWidth(line))
				.toBeLessThanOrEqual(18);
		}

		viewer.handleInput('\r');
		const detailLines = viewer.render(20);

		expect(detailLines.length)
			.toBe(10);

		for (const line of detailLines) {
			expect(visibleWidth(line))
				.toBeLessThanOrEqual(18);
		}
	}
);

test
(
	'keeps elapsed time in the live activity widget',
	() => {
		const history = new ActivityHistory();
		history.start('bash', 'bash', { command: 'sleep 1' }, 1000);

		expect(liveWidget(history.calls, 1300, 120, theme as never)?.join('\n'))
			.toContain('0.3s');
	}
);

test
(
	'shows the reported subagent tool and drops it when progress moves on',
	() => {
		const history = new ActivityHistory();
		history.start('task', 'task', {}, 1000);
		history.update('task', { details: { progress: [{ id: 'Audit', agent: 'reviewer', status: 'running', currentTool: 'read', currentToolArgs: 'agent/STYLE.md' }] } });

		expect(liveWidget(history.calls, 2000, 120, theme as never)?.join('\n'))
			.toContain('Audit · read agent/STYLE.md');

		history.update('task', { details: { progress: [{ id: 'Audit', agent: 'reviewer', status: 'running', recentTools: [{ tool: 'read', args: 'agent/STYLE.md' }] }] } });

		const running = liveWidget(history.calls, 2100, 120, theme as never)!.join('\n');
		for (const text of ['Audit', 'Running']) {
			expect(running)
				.toContain(text);
		}

		expect(liveWidget(history.calls, 2100, 120, theme as never)?.join('\n'))
			.not.toContain('read');

		history.update('task', { details: { progress: [{ id: 'Audit', agent: 'reviewer', status: 'completed', currentTool: 'read', currentToolArgs: 'stale.ts' }] } });

		const completed = liveWidget(history.calls, 2200, 120, theme as never)!.join('\n');
		for (const text of ['Audit', 'Done']) {
			expect(completed)
				.toContain(text);
		}

		expect(liveWidget(history.calls, 2200, 120, theme as never)?.join('\n'))
			.not.toContain('stale.ts');
	}
);

test
(
	'limits parallel agent rows globally and excludes completed siblings while others run',
	() => {
		const history = new ActivityHistory();
		history.start('read', 'read', { path: 'main.ts' }, 1000);
		history.start('task', 'task', {}, 1000);
		history.update
		(
			'task',
			{
				details: {
					progress: [
						{ id: 'Old', status: 'completed', currentTool: 'read' },
						{ id: 'One', status: 'running', currentTool: 'grep', currentToolArgs: 'needle' },
						{ id: 'Two', status: 'pending', currentTool: 'stale' },
						{ id: 'Three', status: 'running' },
						{ id: 'Four', status: 'running' }
					]
				}
			});

		const lines = liveWidget(history.calls, 2000, 120, theme as never)!;
		const rendered = lines.join('\n');

		expect(lines)
			.toHaveLength(5);

		for (const text of ['main.ts', 'One', 'grep needle', 'Two', 'Pending', '+2 more']) {
			expect(rendered)
				.toContain(text);
		}

		for (const text of ['Old', 'Three', 'Four', 'stale']) {
			expect(rendered)
				.not.toContain(text);
		}
	}
);

test
(
	'excludes snapshot-settled task siblings from active rows and overflow counts',
	() => {
		const transitions = [['completed', 'running'], ['failed', 'running'], ['cancelled', 'pending']] as const;
		for (const [status, progressStatus] of transitions) {
			const history = new ActivityHistory();
			history.start('task', 'task', {}, 100);

			const progress = [
				{ id: 'One', status: progressStatus, currentTool: 'read', currentToolArgs: 'stale.ts' },
				{ id: 'Two', status: 'running', currentTool: 'grep', currentToolArgs: 'needle' },
				{ id: 'Three', status: 'running' },
				{ id: 'Four', status: 'running' }
			];

			history.finish('task', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress } }, false, 150);
			history.syncJobs
			(
				{
					running: [{ id: 'Two', status: 'running', startTime: 120 }, { id: 'Three', status: 'running', startTime: 130 }, { id: 'Four', status: 'running', startTime: 140 }],
					recent: [{ id: 'One', status, startTime: 110, endTime: 200 }],
					delivery: { pendingJobIds: [] }
				}
			);

			const lines = liveWidget(history.calls, 300, 120, theme as never)!;

			expect(lines)
				.toHaveLength(4);

			for (const name of ['Two', 'Three', 'Four']) {
				expect(lines.join('\n'))
					.toContain(name);
			}

			expect(lines.join('\n'))
				.not.toContain('One');

			expect(lines.join('\n'))
				.not.toContain('stale.ts');
		}
	}
);

test
(
	'does not let running snapshots override terminal or queued task progress',
	() => {
		const history = new ActivityHistory();
		history.start('task', 'task', {}, 100);
		history.finish('task', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'pending' }] } }, false, 150);
		history.syncJobs({ running: [{ id: 'One', status: 'running', startTime: 110 }, { id: 'Two', status: 'running', startTime: 120 }] });
		history.update('task', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'completed', currentTool: 'read', currentToolArgs: 'stale.ts' }, { id: 'Two', status: 'pending' }] } }, 200);

		const lines = liveWidget(history.calls, 300, 120, theme as never)!;

		expect(lines)
			.toHaveLength(2);

		expect(lines.join('\n'))
			.toContain('Two');

		expect(lines.join('\n'))
			.toContain('Pending');

		expect(lines.join('\n'))
			.not.toContain('One');
	}
);

test
(
	'sanitizes agent progress and uses current intent only when no target is reported',
	() => {
		const history = new ActivityHistory();
		history.start('task', 'task', {}, 1000);
		history.update
		(
			'task',
			{
				details: {
					progress: [
						{ id: 'Audit\x1b[2J\nNext', status: 'running', currentTool: 'bash', currentToolArgs: '\x1b]52;c;secret\x07pwd\nhere', currentToolIntent: 'ignored' },
						{ id: 'Review', status: 'running', currentTool: 'read', currentToolIntent: 'Inspecting rules' }
					]
				}
			});

		const rendered = liveWidget(history.calls, 2000, 120, theme as never)!.join('\n');

		expect(rendered)
			.toContain('Audit Next · bash pwd here');

		expect(rendered)
			.toContain('Review · read Inspecting rules');

		for (const text of ['\x1b', 'secret', 'ignored']) {
			expect(rendered)
				.not.toContain(text);
		}
	}
);

test
(
	'retains ordinary task fallback when progress is unavailable or malformed',
	() => {
		const history = new ActivityHistory();
		history.start('task', 'task', { i: 'Reviewing code' }, 1000);

		for (const progress of [undefined, {}, [null, { status: 'unknown' }]]) {
			history.update('task', { details: { progress } });

			const rendered = liveWidget(history.calls, 2000, 120, theme as never)!.join('\n');
			for (const text of ['task', 'Reviewing code', '1.0s']) {
				expect(rendered)
					.toContain(text);
			}
		}
	}
);

test
(
	'preserves live runtime metadata when long targets fill a narrow widget',
	() => {
		const history = new ActivityHistory();
		history.start('read', 'read', { path: 'very/long/目標/'.repeat(20) }, 1000);
		const lines = liveWidget(history.calls, 2300, 24, theme as never)!;

		for (const line of lines) {
			expect(visibleWidth(line))
				.toBeLessThanOrEqual(24);
		}

		expect(lines[1])
			.toContain('1.3s');
	}
);

function fixture(rows = 16) {
	const history = new ActivityHistory();

	const sources = [
		['first', 'alpha.ts', 'match one'],
		['middle', 'beta.ts', 'hidden needle\nmatch two'],
		['last', 'gamma.ts', 'match three']
	] as const;

	for (const [id, path, text] of sources) {
		history.start(id, 'read', { path }, 1000);
		history.finish(id, { content: [{ type: 'text', text }] }, false, 1200);
	}

	const tui = { terminal: { rows }, requestRender: () => {} };
	let closed = false;
	const viewer = new ActivityViewer(history, tui as never, theme as never, () => { closed = true; });

	const screen = () => viewer.render(120).join('\n');
	screen();

	return { history, viewer, screen, isClosed: () => closed };
}

test
(
	'expands details beneath the selected call without losing chronological neighbors',
	() => {
		const { viewer, screen, isClosed } = fixture(24);
		viewer.handleInput('\x1b[A');
		const collapsed = screen();

		expect(collapsed)
			.not.toContain('hidden needle');

		viewer.handleInput('\r');
		const expanded = screen();
		const first = expanded.indexOf('alpha.ts');
		const selected = expanded.indexOf('beta.ts');
		const details = expanded.indexOf('hidden needle');
		const last = expanded.indexOf('gamma.ts');

		expect(first)
			.toBeGreaterThanOrEqual(0);

		expect(selected)
			.toBeGreaterThan(first);

		expect(details)
			.toBeGreaterThan(selected);

		expect(last)
			.toBeGreaterThan(details);

		viewer.handleInput('\x1b');

		expect(screen())
			.not.toContain('hidden needle');

		expect(isClosed())
			.toBe(false);

		viewer.handleInput('\r');

		expect(screen())
			.toContain('hidden needle');
	}
);

test
(
	'keeps call context while scrolling expanded output to its end',
	() => {
		const { viewer, history, screen } = fixture(16);
		history.update('last', { content: [{ type: 'text', text: Array.from({ length: 30 }, (_, index) => `output ${index}`).join('\n') }] });
		viewer.handleInput('\r');
		screen();
		viewer.handleInput('G');
		const expanded = screen();

		expect(expanded)
			.toContain('output 29');

		expect(expanded)
			.toContain('beta.ts');

		expect(expanded)
			.toContain('gamma.ts');

		viewer.handleInput('\r');

		expect(screen())
			.not.toContain('output 29');

		viewer.handleInput('\x1b[A');
		viewer.handleInput('\r');
		screen();
		viewer.handleInput('G');

		expect(screen())
			.toContain('hidden needle');
	}
);

test
(
	'fits collapsed and expanded history within short and narrow terminal bounds',
	() => {
		for (const rows of [4, 6, 10]) {
			const { viewer } = fixture(rows);
			for (const width of [8, 20, 40]) {
				for (const key of ['\r', '\r']) {
					viewer.handleInput(key);
					const lines = viewer.render(width);

					expect(lines.length)
						.toBeLessThanOrEqual(rows);

					for (const line of lines) {
						expect(visibleWidth(line))
							.toBeLessThanOrEqual(width - 2);
					}
				}
			}
		}
	}
);

test
(
	'keeps the expanded call and its output reachable when only one context row fits',
	() => {
		const { viewer, history } = fixture(10);
		history.calls[2]!.tool = 'focus';
		viewer.render(20);
		viewer.handleInput('\r');

		expect(viewer.render(20).join('\n'))
			.toContain('focus');

		viewer.handleInput('G');

		expect(viewer.render(20).join('\n'))
			.toContain('match three');
	}
);

test
(
	'preserves the complete outcome when a wide target crosses the label boundary',
	() => {
		const { viewer, history } = fixture(10);
		history.calls[2]!.args = { path: '目目目' };
		const row = viewer.render(20).find(line => line.includes('目'));

		expect(row)
			.toContain('Done');
	}
);

test
(
	'navigates to first and last calls with both key pairs',
	() => {
		const { viewer, screen } = fixture();
		for (const [key, call] of [['g', 1], ['G', 3], ['\x1b[H', 1], ['\x1b[F', 3]] as const) {
			viewer.handleInput(key);

			expect(screen())
				.toContain(`Call ${call} / 3`);
		}
	}
);

test
(
	'skips hidden-output matches and repeats only through matching rows',
	() => {
		const { viewer, history, screen } = fixture();
		history.calls[0]!.args = { path: 'needle-first.ts' };
		history.calls[2]!.args = { path: 'needle-last.ts' };
		viewer.handleInput('?');
		viewer.handleInput('needle');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Call 1 / 3');

		viewer.handleInput('N');

		expect(screen())
			.toContain('Call 3 / 3');

		viewer.handleInput('n');

		expect(screen())
			.toContain('Call 1 / 3');

		viewer.handleInput('n');

		expect(screen())
			.toContain('Pattern not found');

		expect(screen())
			.toContain('Call 1 / 3');
	}
);

test
(
	'cancels search entry without navigating or discarding the previous pattern',
	() => {
		const { viewer, screen, isClosed } = fixture();
		viewer.handleInput('?');
		viewer.handleInput('read');
		viewer.handleInput('\r');
		viewer.handleInput('/');
		viewer.handleInput('gGnN');

		expect(screen())
			.toContain('Call 2 / 3');

		viewer.handleInput('\x1b');
		viewer.handleInput('n');

		expect(screen())
			.toContain('Call 1 / 3');

		expect(isClosed())
			.toBe(false);
	}
);

test
(
	'keeps selection on invalid regex and permits editing and an empty-pattern repeat',
	() => {
		const { viewer, screen } = fixture();
		viewer.handleInput('?');
		viewer.handleInput('[');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Invalid pattern');

		expect(screen())
			.toContain('Call 3 / 3');

		viewer.handleInput('?');
		viewer.handleInput('readx');
		viewer.handleInput('\x7f');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Call 2 / 3');

		viewer.handleInput('?');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Call 1 / 3');
	}
);

test
(
	'searches and highlights detail lines and preserves first/last navigation',
	() => {
		const { viewer, history, screen } = fixture(15);
		history.update('last', { content: [{ type: 'text', text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join('\n') }] });
		viewer.handleInput('\r');
		screen();

		viewer.handleInput('/');
		viewer.handleInput('row (12|22)');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('[row 12]');

		viewer.handleInput('n');

		expect(screen())
			.toContain('[row 22]');

		viewer.handleInput('N');

		expect(screen())
			.toContain('[row 12]');

		viewer.handleInput('G');

		expect(screen())
			.toContain('row 29');

		viewer.handleInput('g');

		expect(screen())
			.toContain('Lines 1–');
	}
);

test
(
	'does not revisit bottom-page matches after detail reflow or invalidation',
	() => {
		const { viewer, history, screen } = fixture(24);
		history.update('last', { content: [{ type: 'text', text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join('\n') }] });
		viewer.handleInput('\r');
		screen();

		viewer.handleInput('/');
		viewer.handleInput('row (28|29)');
		viewer.handleInput('\r');
		screen();

		viewer.handleInput('n');
		screen();

		viewer.invalidate();
		viewer.render(80);
		viewer.handleInput('n');

		expect(viewer.render(80).join('\n'))
			.toContain('Pattern not found');

		viewer.handleInput('N');
		viewer.render(80);
		viewer.handleInput('N');

		expect(viewer.render(80).join('\n'))
			.toContain('Pattern not found');
	}
);

test
(
	'reuses the logical detail match for empty-pattern repeats near the bottom',
	() => {
		const { viewer, history, screen } = fixture(24);
		history.update('last', { content: [{ type: 'text', text: Array.from({ length: 30 }, (_, index) => `row ${index}`).join('\n') }] });
		viewer.handleInput('\r');
		screen();

		viewer.handleInput('/');
		viewer.handleInput('row (28|29)');
		viewer.handleInput('\r');
		screen();

		viewer.handleInput('n');
		screen();

		viewer.handleInput('/');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Pattern not found');

		viewer.handleInput('?');
		viewer.handleInput('\r');
		screen();

		viewer.handleInput('?');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Pattern not found');
	}
);

test
(
	'handles zero-width regex matches and empty history without looping',
	() => {
		const { viewer, history, screen } = fixture();
		viewer.handleInput('?');
		viewer.handleInput('^');
		viewer.handleInput('\r');

		expect(screen())
			.toContain('Call 2 / 3');

		history.restore([]);
		viewer.handleInput('n');

		expect(screen())
			.toContain('No tool calls');
	}
);

test
(
	'observes a native clear without session events and does not erase the first post-clear tool',
	async () => {
		const { default: activity } = await import('./activities');
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		let open: CommandHandler;
		const entries: FixtureEntry[] = [
			{ id: 'before', parentId: null, type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'read', arguments: { path: 'old.ts' } }] } }
		];

		let rendered = '';
		const tui = { terminal: { rows: 24, columns: 120 }, requestRender: () => {} };
		const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text, bold: (text: string) => text };

		const ctx = {
			agent: { kind: 'main' },
			mode: 'tui',
			hasUI: true,
			sessionManager: {
				getBranch: () => entries,
				getLeafId: () => entries.at(-1)?.id ?? null,
				getLeafEntry: () => entries.at(-1),
				getEntry: (id: string) => entries.find(entry => entry.id === id)
			},
			getAsyncJobSnapshot: () => ({}),
			setInterval: () => 1,
			clearTimer: () => {},
			ui: {
				setWidget: () => {},
				onTerminalInput: () => () => {},
				custom: async (factory: ViewerFactory) => {
					const viewer = factory(tui, theme, undefined, () => {});
					rendered = viewer.render(120).join('\n');
				}
			}
		};

		activity({
			setLabel: () => {},
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
			registerCommand: (_name: string, command: FixtureCommand) => {
				open = command.handler;
			},
			registerShortcut: () => {},
			appendEntry: () => {}
		} as never);

		await handlers.get('session_start')!({}, ctx);
		await open!('', ctx);

		expect(rendered)
			.toContain('old.ts');

		entries.push({ id: 'clear', parentId: 'before', type: 'reset_boundary' });
		await open!('', ctx);

		expect(rendered)
			.toContain('No tool calls');

		await handlers.get('tool_execution_start')!({ toolCallId: 'new', toolName: 'read', args: { path: 'new.ts' } }, ctx);
		await open!('', ctx);

		expect(rendered)
			.toContain('new.ts');

		expect(rendered)
			.not.toContain('old.ts');

		entries.push({ id: 'clear-again', parentId: 'clear', type: 'reset_boundary' });
		await handlers.get('tool_execution_start')!({ toolCallId: 'after-second-clear', toolName: 'read', args: { path: 'after-second-clear.ts' } }, ctx);
		await open!('', ctx);

		expect(rendered)
			.toContain('after-second-clear.ts');

		expect(rendered)
			.not.toContain('new.ts');

		entries.push({ id: 'kept', parentId: 'clear-again', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'kept-call', name: 'read', arguments: { path: 'kept.ts' } }] } });
		await handlers.get('tool_execution_start')!({ toolCallId: 'kept-call', toolName: 'read', args: { path: 'kept.ts' } }, ctx);
		entries.push({ id: 'kept-result', parentId: 'kept', type: 'message', message: { role: 'toolResult', toolCallId: 'kept-call', content: [], isError: false } });
		await handlers.get('tool_execution_end')!({ toolCallId: 'kept-call', result: { content: [] }, isError: false }, ctx);
		entries.push({ id: 'retry-anchor', parentId: 'kept-result', type: 'message' });
		entries.push({ id: 'failed-result', parentId: 'retry-anchor', type: 'message' });
		await open!('', ctx);
		entries.pop();
		await handlers.get('agent_start')!({}, ctx);
		await open!('', ctx);

		expect(rendered)
			.toContain('kept.ts');
	}
);

test
(
	'reveals a matching target beyond the normal row truncation',
	() => {
		const { viewer, history } = fixture();
		history.calls[0]!.args = { path: `${'prefix/'.repeat(40)}needle.ts` };
		viewer.render(60);
		viewer.handleInput('?');
		viewer.handleInput('needle');
		viewer.handleInput('\r');

		const lines = viewer.render(60);

		expect(lines.join('\n'))
			.toContain('[needle]');

		expect(lines.join('\n'))
			.toContain('Call 1 / 3');
	}
);

test
(
	'backs out of details before closing with q and allows q inside a search pattern',
	() => {
		for (const details of [false, true]) {
			const { viewer, screen, isClosed } = fixture();
			if (details) {
				viewer.handleInput('\r');
				screen();
			}

			viewer.handleInput('/');
			viewer.handleInput('q');

			expect(isClosed())
				.toBe(false);

			viewer.handleInput('\r');
			viewer.handleInput('q');

			if (details) {
				expect(isClosed())
					.toBe(false);

				expect(screen())
					.toContain('Call 3 / 3');

				viewer.handleInput('q');
			}

			expect(isClosed())
				.toBe(true);
		}
	}
);
