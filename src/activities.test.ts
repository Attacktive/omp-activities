import { expect, test } from 'bun:test';
import activity from './activities';
import type { ActivityTiming } from './history';
import type { ActivityViewer } from './viewer';

interface JobSnapshot {
	id: string;
	status: string;
	startTime: number;
	endTime?: number;
}

interface DeliverySnapshot {
	pendingJobIds: string[];
}

interface Snapshot {
	running: JobSnapshot[];
	recent: JobSnapshot[];
	delivery: DeliverySnapshot;
}

type EventHandler = (event: unknown, context: unknown) => unknown;
type CommandHandler = (args: string, context: unknown) => Promise<void>;
type ViewerFactory = (tui: unknown, theme: unknown, keys: unknown, done: () => void) => ActivityViewer;

interface Command {
	handler: CommandHandler;
}

function fixture() {
	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, CommandHandler>();
	const timings: ActivityTiming[] = [];
	const snapshot: Snapshot = { running: [], recent: [], delivery: { pendingJobIds: [] } };
	const tui = { terminal: { rows: 100, columns: 120 }, requestRender: () => {} };
	const theme = { fg: (_style: string, text: string) => text, bg: (_style: string, text: string) => text, bold: (text: string) => text };
	let rendered = '';
	const context = {
		agent: { kind: 'main' },
		mode: 'tui',
		hasUI: true,
		sessionManager: { getBranch: () => [], getLeafId: () => null, getLeafEntry: () => undefined },
		getAsyncJobSnapshot: () => snapshot,
		setInterval: () => 1,
		clearTimer: () => {},
		ui: {
			setWidget: () => {},
			onTerminalInput: () => () => {},
			custom: async (factory: ViewerFactory) => {
				const viewer = factory(tui, theme, undefined, () => {});
				viewer.handleInput('g');
				viewer.handleInput('\r');
				rendered = viewer.render(120).join('\n');
			}
		}
	};

	activity
	(
		{
			setLabel: () => {},
			on: (name: string, handler: EventHandler) => handlers.set(name, handler),
			registerCommand: (name: string, command: Command) => commands.set(name, command.handler),
			registerShortcut: () => {},
			appendEntry: (_type: string, data: ActivityTiming) => timings.push(data)
		} as never
	);

	return {
		snapshot,
		timings,
		emit: (name: string, event: unknown) => handlers.get(name)!(event, context),
		details: async () => {
			await commands.get('activities')!('', context);

			return rendered;
		}
	};
}

test
(
	'retains normal async delivery after the host commits its receipt before agent_start and message_end',
	async () => {
		const app = fixture();
		app.emit('session_start', {});
		app.emit('tool_execution_start', { toolCallId: 'read', toolName: 'bash', args: {} });

		const startTime = Date.now();
		app.snapshot.running = [{ id: 'bg_1', status: 'running', startTime }];
		app.emit('tool_execution_end', { toolCallId: 'read', toolName: 'bash', result: { details: { async: { state: 'running', jobId: 'bg_1' } } }, isError: false });
		app.snapshot.running = [];
		app.snapshot.recent = [{ id: 'bg_1', status: 'completed', startTime, endTime: startTime + 500 }];
		app.snapshot.delivery.pendingJobIds = ['bg_1'];
		app.emit('agent_start', {});
		app.snapshot.delivery.pendingJobIds = [];
		app.emit('agent_start', {});
		app.emit('message_end', { message: { role: 'custom', customType: 'async-result', content: 'delivered final output', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } } });

		expect(await app.details())
			.toContain('delivered final output');

		expect(app.timings.findLast(timing => timing.id === 'read')?.endedAt)
			.toBe(startTime + 500);

		app.emit('session_shutdown', {});
	}
);

test
(
	'retains every batch delivery after receipts disappear and persists the last child end time',
	async () => {
		const app = fixture();
		app.emit('session_start', {});
		app.emit('tool_execution_start', { toolCallId: 'batch', toolName: 'task', args: {} });

		const startTime = Date.now();
		app.snapshot.running = [{ id: 'One', status: 'running', startTime }, { id: 'Two', status: 'running', startTime }];
		app.emit('tool_execution_end', { toolCallId: 'batch', toolName: 'task', result: { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] } }, isError: false });
		app.snapshot.running = [{ id: 'Two', status: 'running', startTime }];
		app.snapshot.recent = [{ id: 'One', status: 'completed', startTime, endTime: startTime + 300 }];
		app.emit('message_end', { message: { role: 'custom', customType: 'async-result', content: 'first batch output', details: { jobs: [{ jobId: 'One', status: 'completed' }] } } });
		app.snapshot.running = [];
		app.snapshot.recent = [{ id: 'Two', status: 'completed', startTime, endTime: startTime + 700 }];
		app.emit('message_end', { message: { role: 'custom', customType: 'async-result', content: 'second batch output', details: { jobs: [{ jobId: 'Two', status: 'completed' }] } } });

		const rendered = await app.details();

		expect(rendered)
			.toContain('first batch output');

		expect(rendered)
			.toContain('second batch output');

		expect(app.timings.findLast(timing => timing.id === 'batch')?.endedAt)
			.toBe(startTime + 700);

		app.emit('session_shutdown', {});
	}
);

test
(
	'retires only completed wait results, not partial wait progress',
	async () => {
		for (const finishWait of [false, true]) {
			const app = fixture();
			app.emit('session_start', {});
			app.emit('tool_execution_start', { toolCallId: 'original', toolName: 'bash', args: {} });

			const startTime = Date.now();
			app.snapshot.running = [{ id: 'bg_1', status: 'running', startTime }];
			app.emit('tool_execution_end', { toolCallId: 'original', toolName: 'bash', result: { details: { async: { state: 'running', jobId: 'bg_1' } } }, isError: false });
			app.emit('tool_execution_start', { toolCallId: 'wait', toolName: 'wait', args: {} });
			app.snapshot.running = [];
			app.snapshot.recent = [{ id: 'bg_1', status: 'completed', startTime, endTime: startTime + 500 }];

			const result = { content: [{ type: 'text', text: 'wait output' }], details: { op: 'wait', jobs: [{ id: 'bg_1', status: 'completed', resultText: 'wait output' }] } };
			app.emit('tool_execution_update', { toolCallId: 'wait', partialResult: result });
			if (finishWait) {
				app.emit('tool_execution_end', { toolCallId: 'wait', toolName: 'wait', result, isError: false });
			}

			app.emit('message_end', { message: { role: 'custom', customType: 'async-result', content: 'late completion payload', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } } });

			const rendered = await app.details();
			if (finishWait) {
				expect(rendered)
					.not.toContain('late completion payload');
			} else {
				expect(rendered)
					.toContain('late completion payload');
			}

			expect(app.timings.findLast(timing => timing.id === 'original')?.endedAt)
				.toBe(startTime + 500);

			app.emit('session_shutdown', {});
		}
	}
);
