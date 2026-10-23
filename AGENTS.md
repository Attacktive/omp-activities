# Agent instructions

`omp-activities` is an unofficial OMP plugin that provides compact tool history and live activity without additional AI model calls.

## Architecture and runtime

OMP loads the TypeScript entry point directly from `src/activities.ts` at runtime without a separate compilation or build step.
Development and test suites run on Bun (`bun test`, `bun run lint`, `bun run typecheck`).
The plugin requires a minimum host version of OMP 18.12.6 (`@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`).

## Session entries and compatibility

Execution timing records are persisted using custom session entries named `dev.attacktive.activity.timing`.
This identifier must remain stable to preserve session timing compatibility across restarts and branch navigations.
Custom entries must never trigger external AI model calls or inject synthetic messages into the conversation context.

## Style and conventions

Code formatting and style follow `STYLE.md` from `Attacktive/omp-config`.
Indent source files with tabs.
Use single quotes for JavaScript and TypeScript string literals.
Keep exactly one sentence per physical line in comments and documentation.
Use American English spelling across identifiers, comments, and documentation.
