# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.2.0] - 2026-10-27

### Changed

- Outline the live activity widget with a dim, theme-colored border while preserving runtime alignment and narrow-terminal truncation.

## [0.1.1] - 2026-10-26

### Changed

- Present activity history as compact chronological rows with outcomes, elapsed time, and optional inline details instead of a separate detail screen.
- Style live Activity with native theme roles, tree connectors, aligned runtime metadata, and a width-aware command hint.

### Fixed

- Preserve history tool identity and tool-name search matches when exit metadata would otherwise consume narrow rows.

## [0.1.0] - 2026-10-23

### Added

- Initial standalone `omp-activities` plugin.
- Interactive activity history viewer accessible through `/activities` or `Ctrl+Alt+A`.
- Case-sensitive regular expression search (`/` forward, `?` backward, `n` next, `N` previous) across tool history rows and call details.
- Live editor widget displaying up to three active tool calls and subagent progress states.
- Session timing persistence stored under `dev.attacktive.activity.timing`.
- Support for resetting visible history on `/clear` using native session boundaries.

### Fixed

- Use a fullscreen history viewer instead of exposing conversation rows above it.
- Keep navigation hints visible in narrow terminals.
- Preserve retained calls when retry rewinds a branch after `/clear`.
- Keep task batches active until all children settle and retain their completion output.
- Reattach live task batches after branch navigation using persisted child-job identities and retain settled sibling states.
- Retire consumed job associations and non-async batch members without dropping pending background deliveries.
- Exclude snapshot-settled task siblings from live rows and overflow counts without overriding newer terminal or queued progress.
- Preserve normal background output after delivery receipts commit by distinguishing explicit wait consumption from an empty delivery queue.
