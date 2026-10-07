import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { LogEntry, LogStatus, LogView } from '../types'

const PANE = 'script-logs'
const TITLE = 'Script logs'
const MAX_ENTRIES = 100
const MAX_LINES = 400
const POLL_MS = 1000

const entries = atom({ plugin: 'script-logs', key: 'entries' } as const, [])
const view = atom({ plugin: 'script-logs', key: 'view' } as const, 'overview')
const onlyLive = atom({ plugin: 'script-logs', key: 'onlyLive' } as const, false)

type Outcome = {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  backgroundTaskId?: string
  taskId?: string
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

export const toLines = (text: string | undefined): string[] =>
  (text ?? '')
    .replace(ANSI, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\t/g, '  '))
    .filter((line, i, all) => line !== '' || i < all.length - 1)

const clip = (lines: string[]) => lines.slice(-MAX_LINES)

// The model is told where a background task writes its output; take the path from that text.
export const outputPathIn = (text: string | undefined) =>
  text?.match(/([A-Za-z]:[\\/][^\s"'`<>]+?\.output|\/[^\s"'`<>]+?\.output)\b/)?.[1]

const ICON: Record<LogStatus, string> = {
  running: '▶',
  background: '◆',
  done: '✓',
  failed: '✗',
  stopped: '■',
}

const COLOR: Record<LogStatus, string> = {
  running: 'yellow',
  background: 'cyan',
  done: 'green',
  failed: 'red',
  stopped: 'gray',
}

// Byte size of each background task's output file at the last read.
const seen = new Map<string, number>()

function patch($: EngineInterface, id: string, fn: (one: LogEntry) => LogEntry) {
  return update($, entries, list => list.map(one => (one.id === id ? fn(one) : one)))
}

async function refreshStatus($: EngineInterface) {
  const list = await read($, entries)
  const running = list.filter(one => one.status === 'running').length
  const bg = list.filter(one => one.status === 'background').length
  $.ui.status(
    running + bg === 0
      ? undefined
      : [running && `▶ ${running} running`, bg && `◆ ${bg} background`]
          .filter(Boolean)
          .join(' · '),
  )
}

async function track(
  $: EngineInterface,
  id: string,
  tool: string,
  title: string,
  command: string,
  agentId: string | undefined,
  run: () => Promise<ToolCallResult>,
) {
  const entry: LogEntry = {
    id,
    tool,
    title,
    command,
    status: 'running',
    lines: [],
    startedAt: await $.clock.now(),
    agentId,
  }
  await update($, entries, list => [...list, entry].slice(-MAX_ENTRIES))
  await refreshStatus($)

  const ran = await run()
  const out = (ran.result ?? {}) as Outcome
  const taskId = out.backgroundTaskId ?? (tool === 'Monitor' ? out.taskId : undefined)

  await patch($, id, one => {
    if (ran.deny !== undefined) {
      return { ...one, status: 'stopped', lines: [`denied: ${ran.deny}`] }
    }
    if (taskId !== undefined) {
      return {
        ...one,
        status: 'background',
        taskId,
        outputPath: outputPathIn(ran.text),
        lines: clip([...one.lines, ...toLines(out.stdout), ...toLines(out.stderr)]),
      }
    }
    const lines =
      out.stdout !== undefined || out.stderr !== undefined
        ? [...toLines(out.stdout), ...toLines(out.stderr)]
        : toLines(ran.text)
    return {
      ...one,
      status: ran.isError ? 'failed' : out.interrupted ? 'stopped' : 'done',
      lines: clip(lines.length === 0 ? ['(no output)'] : lines),
    }
  })
  await refreshStatus($)

  return ran
}

// Read a background task's output file when it has grown since the last read.
async function readOutput($: EngineInterface, one: LogEntry) {
  if (one.outputPath === undefined) return
  try {
    const { size } = await $.fs.stat(one.outputPath)
    if (seen.get(one.id) === size) return
    seen.set(one.id, size)
    const text = await $.fs.read(one.outputPath)
    await patch($, one.id, it => ({ ...it, lines: clip(toLines(text)) }))
  } catch {
    // Gone or too large to read: keep what we have.
  }
}

// Tail the output files of background commands and monitors.
async function pollOutputs($: EngineInterface) {
  for (const one of await read($, entries)) {
    if (one.status === 'background') await readOutput($, one)
  }
}

export type Notification = {
  taskId: string
  status?: string
  event?: string
  outputPath?: string
}

const tag = (text: string, name: string) =>
  text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

export const notificationsIn = (text: string): Notification[] =>
  [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(([, body = '']) => {
    const taskId = tag(body, 'task-id')
    return taskId === undefined
      ? []
      : [{ taskId, status: tag(body, 'status'), event: tag(body, 'event'), outputPath: tag(body, 'output-file') }]
  })

const ENDED: Record<string, LogStatus> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped' }

async function applyNotification($: EngineInterface, note: Notification) {
  await update($, entries, list =>
    list.map(one => {
      if (one.taskId !== note.taskId) return one
      // Until we know its output file, a monitor's events reach us only here.
      const lines =
        note.event !== undefined && one.outputPath === undefined
          ? clip([...one.lines, ...toLines(note.event)])
          : one.lines
      const status = (note.status && ENDED[note.status]) || one.status
      return { ...one, lines, status, outputPath: one.outputPath ?? note.outputPath }
    }),
  )
  // Pick up the last lines the task wrote before it ended.
  if (note.status !== undefined) {
    const one = (await read($, entries)).find(it => it.taskId === note.taskId)
    if (one !== undefined) await readOutput($, one)
  }
}

function toggle($: EngineInterface, id: string) {
  return patch($, id, one => ({ ...one, isCollapsed: !one.isCollapsed }))
}

function setCollapsed($: EngineInterface, ids: string[], isCollapsed: boolean) {
  return update($, entries, list => list.map(one => (ids.includes(one.id) ? { ...one, isCollapsed } : one)))
}

// This mod only watches: if its bookkeeping fails, the call goes on untouched.
const passThrough = <E, R>(_$: unknown, e: E, next: (e: E) => R) => next(e)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'logs', description: 'Open the script logs pane' })
    await $.command.register({ name: 'logs-clear', description: 'Clear the script logs pane' })
    void $.ui.open({ id: PANE, title: TITLE })

    $.clock.every(POLL_MS, () => void pollOutputs($))

    return next(e)
  })

  on('command.run', { command: 'logs' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Script logs pane opened.' }
  })

  on('command.run', { command: 'logs-clear' }, async $ => {
    await update($, entries, list =>
      list.filter(one => one.status === 'running' || one.status === 'background'),
    )
    await refreshStatus($)

    return { text: 'Cleared finished scripts from the log pane.' }
  })

  on('tool.call', { tool: 'Bash' }, ($, e, next) =>
    track($, e.tool_use_id ?? crypto.randomUUID(), 'Bash', e.description ?? e.command, e.command, e.agentId, () => next(e)),
  ).catch(passThrough)

  on('tool.call', { tool: 'PowerShell' }, ($, e, next) =>
    track($, e.tool_use_id ?? crypto.randomUUID(), 'PowerShell', e.description ?? e.command, e.command, e.agentId, () => next(e)),
  ).catch(passThrough)

  on('tool.call', { tool: 'Monitor' }, ($, e, next) =>
    track(
      $,
      e.tool_use_id ?? crypto.randomUUID(),
      'Monitor',
      e.description,
      e.command ?? e.ws?.url ?? '',
      e.agentId,
      () => next(e),
    ),
  ).catch(passThrough)

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id !== undefined && ran.deny === undefined && !ran.isError) {
      await update($, entries, list =>
        list.map(one => (one.taskId === id ? { ...one, status: 'stopped' } : one)),
      )
      await refreshStatus($)
    }

    return ran
  }).catch(passThrough)

  // A background task's notification: its final status, and for monitors without a file, its events.
  on('session.append', async ($, e, next) => {
    const kept = await next(e)

    // Notifications arrive as their own rows or folded into reminders; match on the text either way.
    const text = e.message.content
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .join('\n')
    if (!text.includes('<task-notification>')) return kept

    for (const note of notificationsIn(text)) {
      await applyNotification($, note)
    }
    await refreshStatus($)

    return kept
  }).catch(passThrough)

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, entries)
    const mode: LogView = await read($, view)
    const rows = Math.max(4, (e.viewport?.rows ?? 30) - 4)
    const isLive = (one: LogEntry) => one.status === 'running' || one.status === 'background'

    // hotkey: 1-9 for the entries drawn top to bottom; the toggle collapses or expands one.
    const header = (one: LogEntry, hotkey?: string) => (
      <Box>
        <Button
          key={`toggle-${one.id}`}
          plain
          hotkey={hotkey}
          label={one.isCollapsed ? '▸' : '▾'}
          onPress={() => toggle($, one.id)}
        />
        <Text color={COLOR[one.status]}> {ICON[one.status]} </Text>
        <Text bold wrap="truncate-end">
          {one.tool}
          {one.agentId ? ' (agent)' : ''}: {one.title}
        </Text>
        {one.isCollapsed && one.lines.length > 0 && <Text dimColor> ({one.lines.length} lines)</Text>}
      </Box>
    )

    const isFiltered = await read($, onlyLive)
    const visible = isFiltered ? list.filter(isLive) : list
    const hidden = list.length - visible.length

    const allCollapsed = visible.length > 0 && visible.every(one => one.isCollapsed)
    const controls = (
      <Box>
        <Button
          key="mode"
          hotkey="f"
          label={mode === 'follow' ? 'Show all' : 'Follow latest'}
          onPress={() => update($, view, v => (v === 'follow' ? 'overview' : 'follow'))}
        />
        <Text> </Text>
        <Button
          key="filter"
          hotkey="o"
          label={isFiltered ? `Show finished (${hidden})` : 'Only ongoing'}
          onPress={() => update($, onlyLive, isOn => !isOn)}
        />
        <Text> </Text>
        <Button
          key="all"
          hotkey="a"
          label={allCollapsed ? 'Expand all' : 'Collapse all'}
          onPress={() => setCollapsed($, visible.map(one => one.id), !allCollapsed)}
        />
        <Text> </Text>
        <Button
          key="clear"
          hotkey="c"
          label="Clear finished"
          onPress={() => update($, entries, all => all.filter(isLive))}
        />
      </Box>
    )

    if (visible.length === 0) {
      return (
        <Box flexDirection="column">
          {controls}
          <Text dimColor>
            {list.length === 0
              ? 'No scripts yet. Bash, PowerShell and Monitor calls show up here.'
              : `Nothing running. ${hidden} finished hidden: press o to show them.`}
          </Text>
        </Box>
      )
    }

    if (mode === 'follow') {
      const one = [...list].reverse().find(isLive) ?? list[list.length - 1]!
      return (
        <Box flexDirection="column">
          {controls}
          {header({ ...one, isCollapsed: false })}
          <Text dimColor wrap="truncate-end">$ {one.command}</Text>
          {one.lines.slice(-(rows - 3)).map(line => (
            <Text>{line}</Text>
          ))}
          {one.status === 'running' && one.lines.length === 0 && <Text dimColor>running…</Text>}
        </Box>
      )
    }

    // Overview: fill the room newest first; live entries get more lines than finished ones.
    let room = rows - 1
    const shown: { one: LogEntry; want: number }[] = []
    for (const one of [...visible].reverse()) {
      if (room < 1) break
      const cap = one.isCollapsed ? 0 : isLive(one) ? 12 : 4
      const want = Math.min(one.lines.length, cap, Math.max(0, room - 1))
      shown.unshift({ one, want })
      room -= 1 + want
    }

    return (
      <Box flexDirection="column">
        {controls}
        {shown.map(({ one, want }, i) => (
          <Box flexDirection="column">
            {header(one, i < 9 ? String(i + 1) : undefined)}
            {want > 0 &&
              one.lines.slice(-want).map(line => (
                <Text dimColor={!isLive(one)} wrap="truncate-end">
                  {'    '}
                  {line}
                </Text>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
