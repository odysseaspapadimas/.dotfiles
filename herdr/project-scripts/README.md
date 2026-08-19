# project-scripts

Standalone Ratatui package and Composer script runner for Herdr. It replaces the former Pi `/scripts` extension and opens from any pane with `prefix+a`.

## Features

- Discovers `package.json` and `composer.json` scripts using the same bounded workspace rules as the former Pi extension.
- Detects pnpm, Yarn, Bun, npm, and Composer commands without executing anything during discovery.
- Shows running services first and reconnects to existing `Project services` panes.
- Creates and reuses one services tab per resolved workspace root.
- Starts, focuses, restarts, and stops services without requiring Pi.
- Keeps the popup open after starting or restarting so several services can be launched quickly.

## Keys

- `j`/`k` or arrows: move
- `s`: search; `Esc` leaves search mode
- `o`: toggle running-first ordering
- `Enter`: start without closing the popup; if already running, leave it untouched
- `f`: focus a running service pane and close the popup
- `r`: restart
- `x`: stop
- `q`/`Esc`: close

## Build

Run `dot` from anywhere to rebuild and install the binary when its source changes.
For development:

```bash
cargo test
cargo build --release
```
