# script-logs

A Claude Code mod that adds a live **Script logs** pane for the work Claude runs in the background, which the main window doesn't show as it happens.

- **Background shell commands**: started with `run_in_background`, moved there with `ctrl+b`, or backgrounded after a timeout, tailed live from their output file
- **Monitor** watches, with each event as it arrives
- Subagents' background work, tagged `(agent)`

Ordinary foreground commands are left out: their output already shows in the main window. The mod writes nothing to the status line.

Status icons: `◆` running in the background · `✓` done · `✗` failed · `■` stopped

Each entry's header shows how long it has run (`· 1m 12s`), then how long it took once it ends (`· took 24s`), and the exit code when it is not 0 (`· exit 1`). A running entry has a `[stop]` button that stops the task through Claude Code's own TaskStop.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install script-logs --marketplace naughty00shortie/script-logs
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

## Use

The pane opens at session start when the terminal is at least 144 columns wide; otherwise run `/logs`.

| Key / command | Does |
| --- | --- |
| `/logs` | Open the pane |
| `/logs-clear` | Remove finished entries |
| `1`–`9` or click `▾` | Collapse / expand that entry |
| `a` | Collapse / expand all shown entries |
| `o` | Only show ongoing tasks / show finished again |
| `f` | Toggle between all entries and following the newest ongoing one |
| `c` | Clear finished entries |
| click `[stop]` | Stop that background task |

Keys work while the pane has focus (click it, or `ctrl+x tab`).

The mod only watches: if its own bookkeeping fails, Claude's commands still run untouched.

## Develop

```
claude --plugin-dir /path/to/script-logs   # run it from a checkout
claude plugin validate .                    # check the manifest and hooks
claude plugin test .                        # run tests/*.test.tsx
```

Function-hook mods are an early-access Claude Code feature; the API may change between releases.
