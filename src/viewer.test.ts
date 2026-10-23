import { expect, test } from 'bun:test';
import { visibleWidth } from '@oh-my-pi/pi-tui';
import { ActivityHistory } from './history';
import { ActivityViewer, liveWidget } from './viewer';

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

		expect(listLines.join('\n'))
			.toContain('Enter/q/Esc');

		viewer.handleInput('\r');
		const detailLines = viewer.render(20);

		expect(detailLines.length)
			.toBe(10);

		for (const line of detailLines) {
			expect(visibleWidth(line))
				.toBeLessThanOrEqual(18);
		}

		expect(detailLines.join('\n'))
			.toContain('Enter/q/Esc');
	}
);

test
(
	'keeps elapsed time in the live activity widget',
	() => {
		const history = new ActivityHistory();
		history.start('bash', 'bash', { command: 'sleep 1' }, 1000);

		expect(liveWidget(history.calls, 1300)?.join('\n'))
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

		expect(liveWidget(history.calls, 2000)?.join('\n'))
			.toContain('Audit · read agent/STYLE.md');

		history.update('task', { details: { progress: [{ id: 'Audit', agent: 'reviewer', status: 'running', recentTools: [{ tool: 'read', args: 'agent/STYLE.md' }] }] } });

		expect(liveWidget(history.calls, 2100)?.join('\n'))
			.toContain('Audit · Running');

		expect(liveWidget(history.calls, 2100)?.join('\n'))
			.not.toContain('read');

		history.update('task', { details: { progress: [{ id: 'Audit', agent: 'reviewer', status: 'completed', currentTool: 'read', currentToolArgs: 'stale.ts' }] } });

		expect(liveWidget(history.calls, 2200)?.join('\n'))
			.toContain('Audit · Done');

		expect(liveWidget(history.calls, 2200)?.join('\n'))
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

		const lines = liveWidget(history.calls, 2000)!;

		expect(lines.slice(1))
			.toEqual(['read  main.ts · 1.0s · Running', 'One · grep needle · Running', 'Two · Pending', '+2 more']);

		expect(lines.join('\n'))
			.not.toContain('Old');
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

			expect(liveWidget(history.calls, 300)?.slice(1))
				.toEqual(['Two · grep needle · Running', 'Three · Running', 'Four · Running']);
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

		expect(liveWidget(history.calls, 300)?.slice(1))
			.toEqual(['Two · Pending']);
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

		expect(liveWidget(history.calls, 2000)?.slice(1))
			.toEqual(['Audit Next · bash pwd here · Running', 'Review · read Inspecting rules · Running']);
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

			expect(liveWidget(history.calls, 2000)?.slice(1))
				.toEqual(['task  Reviewing code · 1.0s · Running']);
		}
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
	const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => `[${text}]` };
	let closed = false;
	const viewer = new ActivityViewer(history, tui as never, theme as never, () => { closed = true; });

	const screen = () => viewer.render(120).join('\n');
	screen();

	return { history, viewer, screen, isClosed: () => closed };
}

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

		expect(lines.find(line => line.startsWith('› ')))
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
