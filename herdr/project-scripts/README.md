# project-scripts

Standalone Ratatui package and Composer script runner for Herdr. It replaces the former Pi `/scripts` extension and opens from any pane with `prefix+a`.

## Features

- Discovers `package.json` and `composer.json` scripts using the same bounded workspace rules as the former Pi extension.
- Detects pnpm, Yarn, Bun, npm, and Composer commands without executing anything during discovery.
- Shows running services first and reconnects to existing `Project services` panes.
- Creates and reuses one services tab per resolved workspace root.
- Starts, focuses, restarts, and stops services without requiring Pi.

## Keys

- `j`/`k` or arrows: move
- `s`: search; `Esc` leaves search mode
- `o`: toggle running-first ordering
- `Enter`: start or focus
- `f`: focus
- `r`: restart
- `x`: stop
- `q`/`Esc`: close

## Build

```bash
cargo test
cargo build --release
ln -sf "$PWD/target/release/project-scripts" ~/.local/bin/project-scripts
```
