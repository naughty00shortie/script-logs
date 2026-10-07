# script-logs

A Claude Code mod that adds a live **Script logs** pane: see the output of the scripts Claude runs and the things it is monitoring, as they happen.

- **Bash and PowerShell** commands, with their description, status and output
- **Background commands**, tailed live from their output file
- **Monitor** watches, with each event as it arrives
- Subagents' commands, tagged `(agent)`
- A status line count: `▶ 1 running · ◆ 2 background`

Status icons: `▶` running · `◆` background · `✓` done · `✗` failed · `■` stopped

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
| `o` | Only show ongoing scripts (running or background) / show finished again |
| `f` | Toggle between all entries and following the newest live one |
| `c` | Clear finished entries |

Keys work while the pane has focus (click it, or `ctrl+x tab`).

The mod only watches: if its own bookkeeping fails, your commands still run untouched.

## Develop

```
claude --plugin-dir /path/to/script-logs   # run it from a checkout
claude plugin validate .                    # check the manifest and hooks
claude plugin test .                        # run tests/*.test.tsx
```

Function-hook mods are an early-access Claude Code feature; the API may change between releases.
