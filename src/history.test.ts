import { expect, test } from 'bun:test';
import { ActivityHistory, cleanText, describeTarget, detailText } from './history';

test
(
	'keeps invocation order when concurrent calls finish out of order',
	() => {
		const history = new ActivityHistory();
		history.start('first', 'read', { path: 'one.ts' }, 100);
		history.start('second', 'bash', { command: 'false' }, 200);
		history.finish('second', { content: [], details: { exitCode: 1 } }, true, 300);
		history.finish('first', { content: [{ type: 'text', text: 'hello' }] }, false, 500);

		expect(history.calls.map(call => [call.id, call.state, call.endedAt]))
			.toEqual([['first', 'done', 500], ['second', 'failed', 300]]);
	}
);

test
(
	'keeps background work live until a terminal result arrives',
	() => {
		const history = new ActivityHistory();
		history.start('job', 'bash', { command: 'sleep 1' }, 100);
		history.finish('job', { details: { async: { state: 'running' } } }, false, 200);

		expect(history.calls[0]!.state)
			.toBe('background');

		expect(history.calls[0]!.endedAt)
			.toBeUndefined();

		history.finish('job', { details: { async: { state: 'cancelled' } } }, false, 400);

		expect(history.calls[0]!.state)
			.toBe('canceled');
	}
);

test
(
	'does not cancel a parked job when the foreground agent stops',
	() => {
		const history = new ActivityHistory();
		history.start('foreground', 'read', {}, 100);
		history.start('job', 'bash', {}, 100);
		history.finish('job', { details: { async: { state: 'running' } } }, false, 200);
		history.cancelRunning(300);

		expect(history.calls.map(call => call.state))
			.toEqual(['canceled', 'background']);
	}
);

test
(
	'marks only calls in flight at a confirmed interrupt as canceled',
	() => {
		const history = new ActivityHistory();
		history.start('failure', 'bash', {}, 100);
		history.finish('failure', { content: [], isError: true }, true, 200);
		history.start('interrupted', 'bash', {}, 100);
		history.finish('interrupted', { content: [{ type: 'text', text: 'partial output' }], details: {} }, true, 300);
		history.cancelCalls(new Set(['interrupted']), 310);

		expect(history.calls.map(call => call.state))
			.toEqual(['failed', 'canceled']);
	}
);

test
(
	'restores exact execution timing without confusing assistant timestamps with start time',
	() => {
		const history = new ActivityHistory();
		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a.ts' } }], timestamp: 10 } },
			{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: { id: 'a', startedAt: 100, endedAt: 400, state: 'done' } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'a', toolName: 'read', content: [{ type: 'text', text: 'contents' }], isError: false } },
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'legacy', name: 'bash', arguments: { command: 'pwd' } }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'legacy', toolName: 'bash', content: [], isError: false } }
		];

		history.restore(entries);

		expect(history.calls.map(call => [call.id, call.startedAt, call.endedAt, call.state]))
			.toEqual([['a', 100, 400, 'done'], ['legacy', undefined, undefined, 'done']]);
	}
);

test
(
	'replaces abandoned branch activity and marks unfinished historical calls interrupted',
	() => {
		const history = new ActivityHistory();
		history.start('abandoned', 'bash', {}, 1);

		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'kept', name: 'read', arguments: {} }] } }
		];

		history.restore(entries);

		expect(history.calls.map(call => [call.id, call.state]))
			.toEqual([['kept', 'interrupted']]);
	}
);

test
(
	'updates progress without losing original arguments or duplicating calls',
	() => {
		const history = new ActivityHistory();
		history.start('a', 'bash', { command: 'build' }, 100);
		history.update('a', { content: [{ type: 'text', text: 'step 1' }] });
		history.start('a', 'bash', { command: 'build' }, 200);

		expect(history.calls.map(call => [call.startedAt, call.args, call.result]))
			.toEqual([[100, { command: 'build' }, { content: [{ type: 'text', text: 'step 1' }] }]]);
	}
);

test
(
	'reconciles a background completion by job ID and retains delivered output',
	() => {
		const history = new ActivityHistory();
		history.start('a', 'bash', {}, 100);
		history.finish('a', { details: { async: { state: 'running', jobId: 'bg_1' } } }, false, 200);
		history.syncJobs({ running: [], recent: [{ id: 'bg_1', status: 'completed', startTime: 100, endTime: 900 }] });
		history.deliver({ customType: 'async-result', content: 'final output', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.endedAt, history.calls[0]!.delivery])
			.toEqual(['done', 900, { customType: 'async-result', content: 'final output', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } }]);
	}
);

test
(
	'shows returned text without dumping nested binary image payloads',
	() => {
		const history = new ActivityHistory();
		history.start('image', 'read', {}, 100);
		history.finish('image', { content: [{ type: 'text', text: 'real output' }], details: { images: [{ type: 'image', mimeType: 'image/png', data: 'AAAA-base64-payload' }] } }, false, 200);

		const rendered = detailText(history.calls[0]!);

		expect(rendered)
			.toContain('real output');

		expect(rendered)
			.toContain('image/png');

		expect(rendered)
			.not.toContain('AAAA-base64-payload');
	}
);

test
(
	'strips terminal controls including OSC links, CSI sequences, and carriage-return spoofing',
	() => {
		expect(cleanText('\u001b]52;c;secret\u0007hello\u001b[2J\rworld\t!'))
			.toBe('hello world    !');

		expect(describeTarget({ path: 'a\nb.ts', command: 'ignored' }))
			.toBe('a b.ts');
	}
);

test
(
	'restores an observed background completion even when its delivery was not persisted',
	() => {
		const history = new ActivityHistory();
		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'job', name: 'bash', arguments: {} }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'job', toolName: 'bash', content: [], details: { async: { state: 'running', jobId: 'bg_1' } } } },
			{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: { id: 'job', startedAt: 100, endedAt: 900, state: 'done' } }
		];

		history.restore(entries);

		expect(history.calls.map(call => [call.state, call.startedAt, call.endedAt]))
			.toEqual([['done', 100, 900]]);
	}
);

test
(
	'does not attach a new process background job to a completed call with a reused job ID',
	() => {
		const history = new ActivityHistory();
		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'bash', arguments: {} }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'old', toolName: 'bash', content: [], details: { async: { state: 'running', jobId: 'bg_1' } } } },
			{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: { id: 'old', startedAt: 100, endedAt: 200, jobStartedAt: 110, state: 'done' } },
			{ type: 'custom_message', customType: 'async-result', content: 'old output', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } }
		];

		history.restore(entries);
		history.start('new', 'bash', {}, 1000);
		history.finish('new', { details: { async: { state: 'running', jobId: 'bg_1' } } }, false, 1001);
		history.syncJobs({ running: [{ id: 'bg_1', status: 'running', startTime: 1010 }], recent: [] });

		expect(history.calls.map(call => [call.id, call.state, call.endedAt]))
			.toEqual([['old', 'done', 200], ['new', 'background', undefined]]);

		history.deliver({ customType: 'async-result', content: 'new output', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } });

		expect(history.calls[0]!.delivery)
			.toEqual({ type: 'custom_message', customType: 'async-result', content: 'old output', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } });
	}
);

test
(
	'restarts a failed call on native replay without carrying its previous elapsed time or result',
	() => {
		const history = new ActivityHistory();
		history.start('retry', 'bash', { command: 'old' }, 100);
		history.finish('retry', { content: [{ type: 'text', text: 'old failure' }] }, true, 200);
		history.start('retry', 'bash', { command: 'new' }, 1000);

		expect(history.calls.map(call => [call.state, call.startedAt, call.endedAt, call.args, call.result]))
			.toEqual([['running', 1000, undefined, { command: 'new' }, undefined]]);

		history.finish('retry', { content: [] }, false, 1200);

		expect(history.calls[0]!.endedAt)
			.toBe(1200);
	}
);

test
(
	'restores only calls after the latest clear boundary without old timings or background deliveries',
	() => {
		const history = new ActivityHistory();
		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'bash', arguments: {} }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'old', toolName: 'bash', details: { async: { state: 'running', jobId: 'bg_1' } } } },
			{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: { id: 'reused', startedAt: 100, endedAt: 200, state: 'done' } },
			{ type: 'reset_boundary', id: 'reset-one' },
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'middle', name: 'read', arguments: {} }] } },
			{ type: 'reset_boundary', id: 'reset-two' },
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'reused', name: 'read', arguments: { path: 'new.ts' } }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'reused', toolName: 'read', content: [], isError: false } },
			{ type: 'custom_message', customType: 'async-result', content: 'stale', details: { jobs: [{ jobId: 'bg_1', status: 'completed' }] } }
		];

		history.restore(entries);

		expect(history.calls.map(call => [call.id, call.args, call.startedAt, call.endedAt, call.delivery]))
			.toEqual([['reused', { path: 'new.ts' }, undefined, undefined, undefined]]);

		history.restore(entries.slice(0, 6));

		expect(history.calls)
			.toEqual([]);

		history.restore(entries.slice(0, 3));

		expect(history.calls.map(call => call.id))
			.toEqual(['old']);
	}
);

test
(
	'keeps a task batch live after its primary job finishes and retains every delivery',
	() => {
		const history = new ActivityHistory();
		history.start('batch', 'task', {}, 100);

		const progress = [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }];
		history.finish('batch', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress } }, false, 200);
		history.syncJobs({ recent: [{ id: 'One', status: 'completed', startTime: 110, endTime: 300 }], running: [{ id: 'Two', status: 'running', startTime: 120 }] });
		history.deliver({ customType: 'async-result', content: 'first child output', details: { jobs: [{ jobId: 'One', status: 'completed' }] } });

		expect(history.calls[0]!.state)
			.toBe('background');

		expect(history.calls[0]!.endedAt)
			.toBeUndefined();

		history.update('batch', { details: { async: { type: 'task', state: 'failed', jobId: 'One' }, progress: [{ id: 'One', status: 'completed' }, { id: 'Two', status: 'failed' }] } }, 900);
		history.deliver({ customType: 'async-result', content: 'second child output', details: { jobs: [{ jobId: 'Two', status: 'failed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.endedAt])
			.toEqual(['failed', 900]);

		expect(detailText(history.calls[0]!))
			.toContain('first child output');

		expect(detailText(history.calls[0]!))
			.toContain('second child output');
	}
);

test
(
	'retains async output when a mixed task has already settled on return',
	() => {
		const history = new ActivityHistory();
		const call = history.start('mixed', 'task', {}, 100);
		history.finish('mixed', { details: { async: { type: 'task', state: 'completed', jobId: 'Async' }, progress: [{ id: 'Async', status: 'completed' }, { id: 'Blocking', status: 'completed' }] } }, false, 500);
		history.deliver({ customType: 'async-result', content: 'async child output', details: { jobs: [{ jobId: 'Async', status: 'completed' }] } });

		expect(detailText(call))
			.toContain('async child output');

		expect(call.state)
			.toBe('done');
	}
);

test
(
	'settles canceled queued batch children without an aggregate update',
	() => {
		const history = new ActivityHistory();
		const call = history.start('queued', 'task', {}, 100);
		history.finish('queued', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'pending' }, { id: 'Two', status: 'pending' }] } }, false, 150);
		history.syncJobs({ recent: [{ id: 'One', status: 'cancelled', startTime: 110, endTime: 200 }], running: [{ id: 'Two', status: 'running', startTime: 120 }] });

		expect(call.state)
			.toBe('background');

		history.syncJobs({ recent: [{ id: 'One', status: 'cancelled', startTime: 110, endTime: 200 }, { id: 'Two', status: 'cancelled', startTime: 120, endTime: 300 }] });

		expect([call.state, call.endedAt])
			.toEqual(['canceled', 300]);
	}
);
