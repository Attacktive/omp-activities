import { matchesKey } from '@oh-my-pi/pi-tui';
import type { TUI } from '@oh-my-pi/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { findScopedSettings } from '@oh-my-pi/pi-coding-agent/config/settings';
import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { cfgDisplayHideToolActivity } from '@oh-my-pi/pi-coding-agent/modes/settings';
import { ActivityHistory, TIMING_ENTRY, timingFor } from './history';
import type { ActivityCall } from './history';
import { ActivityViewer, isLive, liveWidget } from './viewer';

const WIDGET_KEY = 'dev.attacktive.activity';

/** Tracks tool activity without changing tools, provider context, or display settings. */
function activity(pi: ExtensionAPI) {
	const history = new ActivityHistory();
	let context: ExtensionContext | undefined;
	let timer: Timer | undefined;
	let viewer: ActivityViewer | undefined;
	let viewerTui: TUI | undefined;
	let widgetTui: TUI | undefined;
	let widgetMounted = false;
	let removeInputListener: (() => void) | undefined;
	let scopedSettings: Settings | undefined;
	let removeSettingsListener: (() => void) | undefined;
	let observedLeaf: string | null = null;
	let observedReset: string | null = null;
	const interruptCandidates = new Set<string>();

	function persist(call: ActivityCall) {
		pi.appendEntry(TIMING_ENTRY, timingFor(call));
	}

	function stopTimer() {
		if (timer !== undefined && context) {
			context.clearTimer(timer);
			timer = undefined;
		}
	}

	function clearSettingsListener() {
		removeSettingsListener?.();
		removeSettingsListener = undefined;
		scopedSettings = undefined;
	}

	function bindSettings(ctx: ExtensionContext) {
		const next = findScopedSettings(ctx.cwd);
		if (!next || next === scopedSettings) {
			return;
		}

		removeSettingsListener?.();
		scopedSettings = next;
		removeSettingsListener = cfgDisplayHideToolActivity.listen(next, () => refresh());
	}

	function shouldShowWidget(live: boolean) {
		if (!live) {
			return false;
		}

		if (!scopedSettings) {
			return true;
		}

		return cfgDisplayHideToolActivity.get(scopedSettings);
	}

	function syncWidget(ctx: ExtensionContext, live: boolean) {
		const visible = shouldShowWidget(live);
		if (visible && !widgetMounted) {
			ctx.ui.setWidget
			(
				WIDGET_KEY,
				(tui, theme) => {
					widgetTui = tui;

					return {
						render(width: number) {
							return liveWidget(history.calls, Date.now(), width, theme) ?? [];
						}
					};
				}
			);

			widgetMounted = true;
		} else if (!visible && widgetMounted) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetMounted = false;
			widgetTui = undefined;
		}
	}

	function syncReset(ctx: ExtensionContext) {
		const manager = ctx.sessionManager;
		const leaf = manager.getLeafId();
		let entry = manager.getLeafEntry();

		while (entry && entry.id !== observedLeaf) {
			if (entry.type === 'reset_boundary') {
				if (entry.id === observedReset) {
					break;
				}

				observedReset = entry.id;
				history.restore([]);
				interruptCandidates.clear();
				viewer?.close();
				break;
			}

			if (!entry.parentId) {
				break;
			}

			entry = manager.getEntry(entry.parentId);
		}

		observedLeaf = leaf;
	}

	function refresh(consumedResult?: unknown) {
		if (!context || context.agent.kind !== 'main') {
			return;
		}

		syncReset(context);
		for (const call of history.syncJobs(context.getAsyncJobSnapshot(), consumedResult)) {
			persist(call);
		}

		if (context.mode !== 'tui') {
			return;
		}

		bindSettings(context);
		const live = history.calls.some(isLive);
		syncWidget(context, live);

		widgetTui?.requestRender();
		viewerTui?.requestRender();
		if (live && timer === undefined) {
			timer = context.setInterval(refresh, 1000);
		} else if (!live) {
			stopTimer();
		}
	}

	function restore(_event: unknown, ctx: ExtensionContext) {
		stopTimer();
		clearSettingsListener();
		removeInputListener?.();
		removeInputListener = undefined;
		interruptCandidates.clear();
		viewer?.close();
		viewer = undefined;
		viewerTui = undefined;
		context?.ui.setWidget(WIDGET_KEY, undefined);
		widgetMounted = false;
		widgetTui = undefined;
		context = ctx;

		if (ctx.agent.kind !== 'main') {
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		history.restore(branch);
		observedReset = branch.findLast(entry => entry.type === 'reset_boundary')?.id ?? null;
		observedLeaf = ctx.sessionManager.getLeafId();

		if (ctx.mode === 'tui') {
			removeInputListener = ctx.ui.onTerminalInput
			(
				data => {
					if (!viewer && (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c'))) {
						interruptCandidates.clear();
						for (const call of history.calls) {
							if (call.state === 'running') {
								interruptCandidates.add(call.id);
							}
						}
					}

					return undefined;
				}
			);
		}

		refresh();
	}

	async function open(ctx: ExtensionContext) {
		if (ctx.mode !== 'tui' || !ctx.hasUI || ctx.agent.kind !== 'main') {
			ctx.ui.notify('Tool history requires the interactive terminal UI.', 'info');
			return;
		}

		if (viewer) {
			return;
		}

		context = ctx;
		refresh();

		try {
			await ctx.ui.custom<void>
			(
				(tui, theme, _keys, done) => {
					viewerTui = tui;
					viewer = new ActivityViewer(history, tui, theme, () => done(undefined));
					refresh();

					return viewer;
				},
				{ overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0, fullscreen: true, mouseTracking: false } }
			);
		} finally {
			viewer = undefined;
			viewerTui = undefined;
			refresh();
		}
	}

	pi.setLabel('Activity history');

	pi.registerCommand('activities', { description: 'Browse compact tool history and full call details', handler: async (_args, ctx) => open(ctx) });
	pi.registerShortcut('ctrl+alt+a', { description: 'Open tool history', handler: open });

	pi.on('session_start', restore);
	pi.on('session_switch', restore);
	pi.on('session_branch', restore);
	pi.on('session_tree', restore);

	pi.on
	(
		'agent_start',
		(_event, ctx) => {
			if (ctx.agent.kind !== 'main') {
				return;
			}

			context = ctx;
			refresh();
			interruptCandidates.clear();
		}
	);

	pi.on
	(
		'tool_execution_start',
		(event, ctx) => {
			if (ctx.agent.kind !== 'main') {
				return;
			}

			context = ctx;
			syncReset(ctx);
			persist(history.start(event.toolCallId, event.toolName, event.args, Date.now()));
			refresh();
		}
	);

	pi.on
	(
		'tool_execution_update',
		(event, ctx) => {
			if (ctx.agent.kind !== 'main') {
				return;
			}

			const call = history.update(event.toolCallId, event.partialResult, Date.now());
			if (call) {
				persist(call);
			}

			refresh();
		}
	);

	pi.on
	(
		'tool_execution_end',
		(event, ctx) => {
			if (ctx.agent.kind !== 'main') {
				return;
			}

			context = ctx;
			const call = history.finish(event.toolCallId, event.result, event.isError, Date.now());
			if (call) {
				persist(call);
			}

			refresh(event.result);
		}
	);

	pi.on
	(
		'message_end',
		(event, ctx) => {
			if (ctx.agent.kind !== 'main') {
				return;
			}

			if (event.message.role === 'toolResult') {
				const call = history.update(event.message.toolCallId, event.message, Date.now());
				if (call) {
					persist(call);
				}
			} else if (event.message.role === 'custom') {
				// Capture the host's completion time before delivery retires its job association.
				refresh();
				history.deliver(event.message);
			} else if (event.message.role === 'assistant' && event.message.stopReason === 'aborted') {
				for (const call of history.cancelCalls(interruptCandidates, Date.now())) {
					persist(call);
				}

				interruptCandidates.clear();
			}

			refresh();
		}
	);

	pi.on
	(
		'agent_end',
		(_event, ctx) => {
			if (ctx.agent.kind !== 'main') {
				return;
			}

			for (const call of history.cancelRunning(Date.now())) {
				persist(call);
			}

			refresh();
		}
	);

	pi.on
	(
		'session_shutdown',
		() => {
			stopTimer();
			clearSettingsListener();
			removeInputListener?.();
			viewer?.close();
			viewer = undefined;
			viewerTui = undefined;
			context?.ui.setWidget(WIDGET_KEY, undefined);
		}
	);
}

export { activity as default };
