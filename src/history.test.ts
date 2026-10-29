import { expect, test } from 'bun:test';
import { ActivityHistory, cleanText, describeTarget, detailText, timingFor } from './history';

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

test
(
	'reattaches a two-agent batch after navigating away and back and retains its completions',
	() => {
		const history = new ActivityHistory();
		const call = history.start('batch', 'task', {}, 100);
		const details = { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] };
		history.finish('batch', { details }, false, 150);

		const running = [{ id: 'One', status: 'running', startTime: 110 }, { id: 'Two', status: 'running', startTime: 120 }];
		history.syncJobs({ running, recent: [] });

		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'batch', name: 'task', arguments: {} }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'batch', details } },
			{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: JSON.parse(JSON.stringify(timingFor(call))) }
		];

		history.restore([]);
		history.restore(entries);
		history.syncJobs({ running, recent: [] });

		expect(history.calls[0]!.state)
			.toBe('background');

		history.syncJobs({ running: [running[1]], recent: [{ id: 'One', status: 'completed', startTime: 110, endTime: 300 }] });
		history.deliver({ customType: 'async-result', content: 'first restored output', details: { jobs: [{ jobId: 'One', status: 'completed' }] } });

		expect(history.calls[0]!.state)
			.toBe('background');

		history.syncJobs({ running: [], recent: [{ id: 'Two', status: 'completed', startTime: 120, endTime: 900 }] });
		history.deliver({ customType: 'async-result', content: 'second restored output', details: { jobs: [{ jobId: 'Two', status: 'completed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.endedAt])
			.toEqual(['done', 900]);

		expect(detailText(history.calls[0]!))
			.toContain('first restored output');

		expect(detailText(history.calls[0]!))
			.toContain('second restored output');

		history.restore(entries);
		history.syncJobs({ running: [{ id: 'One', status: 'running', startTime: 1010 }, { id: 'Two', status: 'running', startTime: 1020 }], recent: [] });
		history.deliver({ customType: 'async-result', content: 'unrelated new output', details: { jobs: [{ jobId: 'One', status: 'completed' }, { jobId: 'Two', status: 'completed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.delivery])
			.toEqual(['interrupted', undefined]);
	}
);

test
(
	'retires wait-consumed completions without discarding another pending delivery',
	() => {
		const history = new ActivityHistory();
		const consumed = history.start('consumed', 'bash', {}, 100);
		const pending = history.start('pending', 'bash', {}, 100);
		history.finish('consumed', { details: { async: { state: 'running', jobId: 'bg_1' } } }, false, 150);
		history.finish('pending', { details: { async: { state: 'running', jobId: 'bg_2' } } }, false, 150);
		history.syncJobs
		(
			{
				running: [],
				recent: [{ id: 'bg_1', status: 'completed', startTime: 110, endTime: 300 }, { id: 'bg_2', status: 'failed', startTime: 120, endTime: 400 }],
				delivery: { pendingJobIds: ['bg_2'] }
			},
			{ details: { op: 'wait', jobs: [{ id: 'bg_1', status: 'completed', resultText: 'consumed output' }, { id: 'bg_2', status: 'running' }] } }
		);

		history.syncJobs(null);
		history.deliver({ customType: 'async-result', content: 'unrelated reused job', details: { jobs: [{ jobId: 'bg_1', status: 'failed' }] } });
		history.deliver({ customType: 'async-result', content: 'pending failure output', details: { jobs: [{ jobId: 'bg_2', status: 'failed' }] } });

		expect([consumed.state, consumed.endedAt, consumed.delivery])
			.toEqual(['done', 300, undefined]);

		expect([pending.state, pending.endedAt])
			.toEqual(['failed', 400]);

		expect(detailText(pending))
			.toContain('pending failure output');
	}
);

test
(
	'retires consumed batch children while retaining their terminal state until the last child settles',
	() => {
		const history = new ActivityHistory();
		const call = history.start('batch', 'task', {}, 100);
		history.finish('batch', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] } }, false, 150);
		history.syncJobs
		(
			{
				running: [{ id: 'Two', status: 'running', startTime: 120 }],
				recent: [{ id: 'One', status: 'failed', startTime: 110, endTime: 300 }],
				delivery: { pendingJobIds: [] }
			},
			{ details: { op: 'wait', jobs: [{ id: 'One', status: 'failed', errorText: 'consumed failure' }, { id: 'Two', status: 'running' }] } }
		);

		history.deliver({ customType: 'async-result', content: 'unrelated first child', details: { jobs: [{ jobId: 'One', status: 'completed' }] } });

		expect([call.state, call.delivery])
			.toEqual(['background', undefined]);

		history.syncJobs
		(
			{ running: [], recent: [{ id: 'Two', status: 'completed', startTime: 120, endTime: 500 }], delivery: { pendingJobIds: [] } },
			{ details: { op: 'wait', jobs: [{ id: 'Two', status: 'completed', resultText: 'consumed output' }] } }
		);

		history.deliver({ customType: 'async-result', content: 'unrelated second child', details: { jobs: [{ jobId: 'Two', status: 'completed' }] } });

		expect([call.state, call.endedAt, call.delivery])
			.toEqual(['failed', 500, undefined]);
	}
);

test
(
	'retires non-async mixed batch members and settles tracking even when recent rows are empty',
	() => {
		const history = new ActivityHistory();
		const call = history.start('mixed', 'task', {}, 100);
		history.finish('mixed', { details: { async: { type: 'task', state: 'completed', jobId: 'Async' }, results: [{ id: 'Blocking' }], progress: [{ id: 'Async', status: 'completed' }, { id: 'Blocking', status: 'completed' }] } }, false, 500);
		history.syncJobs({ running: [], recent: [], delivery: { pendingJobIds: ['Async'] } });
		history.deliver({ customType: 'async-result', content: 'unrelated blocking name', details: { jobs: [{ jobId: 'Blocking', status: 'completed' }] } });

		expect(call.delivery)
			.toBeUndefined();

		history.deliver({ customType: 'async-result', content: 'retained async output', details: { jobs: [{ jobId: 'Async', status: 'completed' }] } });

		expect(detailText(call))
			.toContain('retained async output');

		expect([call.state, call.endedAt])
			.toEqual(['done', 500]);
	}
);

test
(
	'retains the last child when aggregate completion precedes host job settlement',
	() => {
		const history = new ActivityHistory();
		const call = history.start('batch', 'task', {}, 100);
		history.finish('batch', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] } }, false, 150);
		history.update('batch', { details: { async: { type: 'task', state: 'completed', jobId: 'One' }, progress: [{ id: 'One', status: 'completed' }, { id: 'Two', status: 'completed' }] } }, 500);
		history.syncJobs
		(
			{
				running: [{ id: 'Two', status: 'running', startTime: 120 }],
				recent: [{ id: 'One', status: 'completed', startTime: 110, endTime: 300 }],
				delivery: { pendingJobIds: [] }
			}
		);

		history.syncJobs({ running: [], recent: [{ id: 'Two', status: 'completed', startTime: 120, endTime: 510 }], delivery: { pendingJobIds: ['Two'] } });
		history.deliver({ customType: 'async-result', content: 'last child output', details: { jobs: [{ jobId: 'Two', status: 'completed' }] } });

		expect(detailText(call))
			.toContain('last child output');

		expect(call.state)
			.toBe('done');
	}
);

test
(
	'does not retire a new call when an older batch child job ID is reused',
	() => {
		const history = new ActivityHistory();
		const batch = history.start('batch', 'task', {}, 100);
		history.finish('batch', { details: { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] } }, false, 150);
		history.syncJobs({ running: [{ id: 'One', status: 'running', startTime: 110 }, { id: 'Two', status: 'running', startTime: 120 }] });
		history.syncJobs({ running: [{ id: 'Two', status: 'running', startTime: 120 }], recent: [{ id: 'One', status: 'completed', startTime: 110, endTime: 300 }] });
		history.deliver({ customType: 'async-result', content: 'old first child output', details: { jobs: [{ jobId: 'One', status: 'completed' }] } });

		const newer = history.start('newer', 'bash', {}, 1000);
		history.finish('newer', { details: { async: { state: 'running', jobId: 'One' } } }, false, 1050);
		history.syncJobs({ running: [{ id: 'One', status: 'running', startTime: 1010 }, { id: 'Two', status: 'running', startTime: 120 }], delivery: { pendingJobIds: [] } });
		history.syncJobs({ running: [{ id: 'Two', status: 'running', startTime: 120 }], recent: [{ id: 'One', status: 'completed', startTime: 1010, endTime: 1500 }], delivery: { pendingJobIds: ['One'] } });
		history.deliver({ customType: 'async-result', content: 'new job output', details: { jobs: [{ jobId: 'One', status: 'completed' }] } });

		expect([newer.state, newer.endedAt])
			.toEqual(['done', 1500]);

		expect(detailText(newer))
			.toContain('new job output');

		expect(detailText(batch))
			.not.toContain('new job output');

		expect(batch.state)
			.toBe('background');
	}
);

test
(
	'reconciles wait-consumed jobs omitted from the five recent snapshot rows',
	() => {
		const history = new ActivityHistory();
		const running = [];
		const completed = [];
		const consumed = [];
		for (let index = 0; index < 6; index++) {
			const id = `job-${index}`;
			const startTime = 110 + index;
			history.start(id, 'bash', {}, 100);
			history.finish(id, { details: { async: { state: 'running', jobId: id } } }, false, 150);
			running.push({ id, status: 'running', startTime });
			completed.push({ id, status: 'completed', startTime, endTime: startTime + 500 });
			consumed.push({ id, status: 'completed', durationMs: 500, resultText: `output-${index}` });
		}

		history.syncJobs({ running, recent: [] });
		history.syncJobs
		(
			{ running: [], recent: completed.slice(1), delivery: { pendingJobIds: [] } },
			{ details: { op: 'wait', jobs: consumed } }
		);

		expect(history.calls.map(call => [call.state, call.endedAt]))
			.toEqual([['done', 610], ['done', 611], ['done', 612], ['done', 613], ['done', 614], ['done', 615]]);

		history.deliver({ customType: 'async-result', content: 'unrelated reuse', details: { jobs: [{ jobId: 'job-0', status: 'failed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.delivery])
			.toEqual(['done', undefined]);
	}
);

test
(
	'describes structured targets for task, eval, todo, and ask calls before falling back to intent',
	() => {
		expect(describeTarget({ tasks: [{ name: 'Audit' }, { agent: 'reviewer' }], i: 'Running agents' }))
			.toBe('Audit, reviewer');

		expect(describeTarget({ tasks: [{ task: 'Inspect conventions\nacross files' }], i: 'Running task' }))
			.toBe('Inspect conventions across files');

		expect(describeTarget({ language: 'py', title: 'Plot latency', code: 'print(1)', i: 'Evaluating python' }))
			.toBe('Plot latency');

		expect(describeTarget({ language: 'js', code: '\n  const x = 1;\n  console.log(x);\n', i: 'Evaluating code' }))
			.toBe('const x = 1; console.log(x);');

		expect(describeTarget({ op: 'done', task: 'Verify baseline tests', i: 'Updating todo' }))
			.toBe('done Verify baseline tests');

		expect(describeTarget({ op: 'init', list: [{ phase: 'Build', items: ['One'] }], i: 'Initializing todos' }))
			.toBe('init Build');

		expect(describeTarget({ questions: [{ header: 'Storage', question: 'Which database?' }], i: 'Asking user' }))
			.toBe('Storage');

		expect(describeTarget({ questions: [{ question: 'Which database?' }], i: 'Asking user' }))
			.toBe('Which database?');

		expect(describeTarget({ i: 'Fallback intent' }))
			.toBe('Fallback intent');
	}
);

test
(
	'tracks and reconciles a single-agent task call with the same child job lifecycle as a batch',
	() => {
		const history = new ActivityHistory();
		const call = history.start('single', 'task', { tasks: [{ name: 'Scout', agent: 'scout', task: 'Find entry' }] }, 100);
		history.finish('single', { details: { async: { type: 'task', state: 'running', jobId: 'Scout' }, progress: [{ id: 'Scout', status: 'running' }] } }, false, 150);
		history.syncJobs({ running: [{ id: 'Scout', status: 'running', startTime: 110 }], recent: [] });

		expect(call.state)
			.toBe('background');

		history.syncJobs({ running: [], recent: [{ id: 'Scout', status: 'completed', startTime: 110, endTime: 450 }] });
		history.deliver({ customType: 'async-result', content: 'single scout report', details: { jobs: [{ jobId: 'Scout', status: 'completed' }] } });

		expect([call.state, call.endedAt])
			.toEqual(['done', 450]);

		expect(detailText(call))
			.toContain('single scout report');
	}
);

test
(
	'settles a fresh single-agent task call with a suffixed jobId when the colliding unsuffixed job remains in snapshots',
	() => {
		const history = new ActivityHistory();
		const older = { id: 'Scout', status: 'completed', startTime: 10, endTime: 50 };
		const call = history.start('single', 'task', { tasks: [{ name: 'Scout', agent: 'scout', task: 'Find entry' }] }, 100);
		history.finish('single', { details: { async: { type: 'task', state: 'running', jobId: 'Scout-2' }, progress: [{ id: 'Scout', status: 'running' }] } }, false, 105);
		history.syncJobs({ running: [{ id: 'Scout-2', status: 'running', startTime: 110 }], recent: [older] });

		expect(call.state)
			.toBe('background');

		history.syncJobs({ running: [], recent: [older, { id: 'Scout-2', status: 'completed', startTime: 110, endTime: 450 }] });
		history.deliver({ customType: 'async-result', content: 'suffixed scout report', details: { jobs: [{ jobId: 'Scout-2', status: 'completed' }] } });

		expect([call.state, call.endedAt])
			.toEqual(['done', 450]);

		expect(detailText(call))
			.toContain('suffixed scout report');
	}
);

test
(
	'reattaches a restored legacy single-agent task call using persisted jobStartedAt identity and suffixed jobId',
	() => {
		const history = new ActivityHistory();
		const details = { async: { type: 'task', state: 'running', jobId: 'Scout-2' }, progress: [{ id: 'Scout', status: 'running' }] };
		const entries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'single', name: 'task', arguments: { tasks: [{ name: 'Scout' }] } }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'single', toolName: 'task', content: [], details } },
			{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: { id: 'single', startedAt: 100, jobStartedAt: 110, state: 'background' } }
		];

		const older = { id: 'Scout', status: 'completed', startTime: 10, endTime: 50 };
		history.restore(entries);
		history.syncJobs({ running: [{ id: 'Scout-2', status: 'running', startTime: 110 }], recent: [older] });

		expect(history.calls[0]!.state)
			.toBe('background');

		history.syncJobs({ running: [], recent: [older, { id: 'Scout-2', status: 'completed', startTime: 110, endTime: 450 }] });
		history.deliver({ customType: 'async-result', content: 'restored single scout report', details: { jobs: [{ jobId: 'Scout-2', status: 'completed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.endedAt])
			.toEqual(['done', 450]);

		expect(detailText(history.calls[0]!))
			.toContain('restored single scout report');

		history.restore(entries);
		history.syncJobs({ running: [{ id: 'Scout-2', status: 'running', startTime: 1010 }], recent: [] });
		history.deliver({ customType: 'async-result', content: 'unrelated scout report', details: { jobs: [{ jobId: 'Scout-2', status: 'completed' }] } });

		expect([history.calls[0]!.state, history.calls[0]!.delivery])
			.toEqual(['interrupted', undefined]);
	}
);

test
(
	'restores terminal task deliveries when final timing entries are absent or stale',
	() => {
		const history = new ActivityHistory();
		const singleDetails = { async: { type: 'task', state: 'running', jobId: 'Scout-2' }, progress: [{ id: 'Scout', status: 'running' }] };

		for (const [status, expectedState] of [['completed', 'done'], ['failed', 'failed'], ['cancelled', 'canceled']] as const) {
			for (const withStaleTiming of [false, true]) {
				const entries: unknown[] = [
					{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'single', name: 'task', arguments: { tasks: [{ name: 'Scout' }] } }] } },
					{ type: 'message', message: { role: 'toolResult', toolCallId: 'single', toolName: 'task', content: [], details: singleDetails } }
				];

				if (withStaleTiming) {
					entries.push({ type: 'custom', customType: 'dev.attacktive.activity.timing', data: { id: 'single', startedAt: 100, jobStartedAt: 110, state: 'background' } });
				}

				entries.push({ type: 'custom_message', customType: 'async-result', content: 'terminal scout report', details: { jobs: [{ jobId: 'Scout-2', status }] } });

				history.restore(entries);
				history.syncJobs({ running: [], recent: [] });

				expect(history.calls[0]!.state)
					.toBe(expectedState);

				expect(detailText(history.calls[0]!))
					.toContain('terminal scout report');
			}
		}

		const batchDetails = { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] };
		const partialBatchEntries = [
			{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'batch', name: 'task', arguments: {} }] } },
			{ type: 'message', message: { role: 'toolResult', toolCallId: 'batch', toolName: 'task', content: [], details: batchDetails } },
			{ type: 'custom_message', customType: 'async-result', content: 'first child report', details: { jobs: [{ jobId: 'One', status: 'completed' }] } }
		];

		history.restore(partialBatchEntries);

		expect(history.calls[0]!.state)
			.toBe('interrupted');

		history.restore([...partialBatchEntries, { type: 'custom_message', customType: 'async-result', content: 'second child failure', details: { jobs: [{ jobId: 'Two', status: 'failed' }] } }]);

		expect(history.calls[0]!.state)
			.toBe('failed');
	}
);

test
(
	'preserves terminal timing state when only some batch children have delivery receipts',
	() => {
		const history = new ActivityHistory();
		const batchDetails = { async: { type: 'task', state: 'running', jobId: 'One' }, progress: [{ id: 'One', status: 'running' }, { id: 'Two', status: 'running' }] };
		const delivery = { type: 'custom_message', customType: 'async-result', content: 'first child report', details: { jobs: [{ jobId: 'One', status: 'completed' }] } };
		const consumed = { details: { op: 'wait', jobs: [{ id: 'Two', status: 'completed', resultText: 'second child report', durationMs: 380 }] } };

		for (const expectedState of ['done', 'failed', 'canceled'] as const) {
			const timing = {
				id: 'batch',
				startedAt: 100,
				endedAt: 500,
				state: expectedState,
				jobTimings: {
					One: { startedAt: 110, status: 'completed', endedAt: 300 },
					Two: { startedAt: 120, status: 'running' }
				}
			};

			const entries = [
				{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'batch', name: 'task', arguments: {} }] } },
				{ type: 'message', message: { role: 'toolResult', toolCallId: 'batch', toolName: 'task', content: [], details: batchDetails } },
				delivery,
				{ type: 'message', message: { role: 'toolResult', toolCallId: 'wait', toolName: 'jobs', details: consumed.details } },
				{ type: 'custom', customType: 'dev.attacktive.activity.timing', data: timing }
			];

			history.restore(entries);
			history.syncJobs({ running: [], recent: [] });

			expect(history.calls[0]!.state)
				.toBe(expectedState);

			expect(history.calls[0]!.endedAt)
				.toBe(500);

			expect(detailText(history.calls[0]!))
				.toContain('first child report');
		}

		const live = new ActivityHistory();
		const call = live.start('live-batch', 'task', {}, 100);
		live.finish('live-batch', { details: batchDetails }, false, 150);
		live.update('live-batch', { details: { async: { type: 'task', state: 'completed', jobId: 'One' }, progress: [{ id: 'One', status: 'completed' }, { id: 'Two', status: 'completed' }] } }, 500);

		expect(call.state)
			.toBe('done');

		live.deliver(delivery);

		expect(call.state)
			.toBe('done');
	}
);
