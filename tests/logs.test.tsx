import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { formatDuration, notificationsIn, outputPathIn, splitExit, toLines } from '../hooks/register'

const SURFACES = ['terminal', 'desktop'] as const

describe('script-logs', () => {
  test('splits output into clean lines', () => {
    expect(toLines('\x1b[32mok\x1b[0m\r\nnext\n')).toEqual(['ok', 'next'])
    expect(toLines(undefined)).toEqual([])
  })

  test('finds a background task output path', () => {
    const path = 'C:/Temp/claude/x/tasks/b6f.output'
    expect(outputPathIn(`Running in background. Output is being written to: ${path}`)).toBe(path)
    expect(outputPathIn('no file here')).toBeUndefined()
  })

  test('takes the exit code out of the output', () => {
    expect(splitExit(['step 1', 'done', '', '[exited with code 1]', ''])).toEqual({ lines: ['step 1', 'done'], exitCode: 1 })
    expect(splitExit(['still going'])).toEqual({ lines: ['still going'] })
  })

  test('formats durations', () => {
    expect(formatDuration(4_000)).toBe('4s')
    expect(formatDuration(72_000)).toBe('1m 12s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
  })

  test('reads monitor events and final status from notifications', () => {
    const text = [
      '<task-notification><task-id>m1</task-id><event>monitor event 1/8</event></task-notification>',
      '<task-notification><task-id>m1</task-id><output-file>C:/t/m1.output</output-file><status>completed</status></task-notification>',
    ].join(' ')
    expect(notificationsIn(text)).toEqual([
      { taskId: 'm1', status: undefined, event: 'monitor event 1/8', outputPath: undefined },
      { taskId: 'm1', status: 'completed', event: undefined, outputPath: 'C:/t/m1.output' },
    ])
  })

  for (const surface of SURFACES) {
    const mountPane = ($: Engine) =>
      $.ui.mount({
        plugin: 'script-logs',
        surface,
        component: 'Pane',
        requestId: 'script-logs',
        props: { title: 'Script logs' } as never,
      })

    // A test engine answer for a command that went to the background.
    const backgrounded = (taskId: string, stdout = '') => ({
      result: { stdout, stderr: '', interrupted: false, backgroundTaskId: taskId },
    })

    test(`skips foreground commands, lists background ones (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', (_$, e) =>
        e.tool_use_id === 'bg'
          ? backgrounded('task-bg', 'started in background')
          : { result: { stdout: 'foreground output', stderr: '', interrupted: false } },
      )
      await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'Quick script', tool_use_id: 'fg' })
      await $.tool.call({ tool: 'PowerShell', command: 'dir', description: 'Quick listing', tool_use_id: 'ps' })
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Long job', tool_use_id: 'bg', run_in_background: true })

      const ui = await mountPane($)
      expect(await ui.find({ text: /Quick script/ })).toBeUndefined()
      expect(await ui.find({ text: /Quick listing/ })).toBeUndefined()
      expect(await ui.find({ text: /foreground output/ })).toBeUndefined()
      expect(await ui.find({ text: /Long job/ })).toBeDefined()
      expect(await ui.find({ text: /started in background/ })).toBeDefined()
    })

    test(`lists a Monitor (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', () => ({ result: { taskId: 'mon-1', timeoutMs: 60000 } }))
      await $.tool.call({ tool: 'Monitor', description: 'Watch the deploy', command: 'tail -f x', timeout_ms: 60000, tool_use_id: 'm' })

      const ui = await mountPane($)
      expect(await ui.find({ text: /Watch the deploy/ })).toBeDefined()
    })

    test(`writes nothing to the status line (${surface})`, async ($, on) => {
      mock.clock(on)
      const statuses: (string | undefined)[] = []
      on('ui.status', (_$, e) => {
        statuses.push(e.text)
        return undefined as never
      })
      on('tool.call', (_$, e) =>
        e.tool_use_id === 'bg' ? backgrounded('task-bg') : { result: { stdout: 'x', stderr: '', interrupted: false } },
      )
      await $.tool.call({ tool: 'Bash', command: 'echo', description: 'Quick', tool_use_id: 'fg' })
      await $.tool.call({ tool: 'Bash', command: 'sleep 9', description: 'Slow', tool_use_id: 'bg', run_in_background: true })

      expect(statuses.filter(text => text !== undefined)).toEqual([])
    })

    test(`collapses and expands an entry (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', () => backgrounded('task-2', 'line one' + String.fromCharCode(10) + 'line two'))
      await $.tool.call({ tool: 'Bash', command: 'echo', description: 'Two lines', tool_use_id: 't2', run_in_background: true })

      const ui = await mountPane($)
      expect(await ui.find({ text: /line two/ })).toBeDefined()

      await ui.press({ key: 'toggle-t2' })
      expect(await ui.find({ text: /line two/ })).toBeUndefined()
      expect(await ui.find({ text: /2 lines/ })).toBeDefined()

      await ui.press({ key: 'toggle-t2' })
      expect(await ui.find({ text: /line two/ })).toBeDefined()
    })

    test(`shows how long a task has run, then how long it took (${surface})`, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      on('tool.call', (_$, e) => (e.tool === 'TaskStop' ? { result: { message: 'stopped' } } : backgrounded('task-t')))
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Timed job', tool_use_id: 'timed', run_in_background: true })

      await clock.advance(72_000)
      const ui = await mountPane($)
      expect(await ui.find({ text: /1m 12s/ })).toBeDefined()

      await $.tool.call({ tool: 'TaskStop', task_id: 'task-t', tool_use_id: 'stop-t' })
      expect(await ui.find({ text: /took 1m 12s/ })).toBeDefined()
    })

    test(`stops a task from the pane (${surface})`, async ($, on) => {
      mock.clock(on)
      const stopped: string[] = []
      on('tool.call', (_$, e) => {
        if (e.tool === 'TaskStop') {
          stopped.push(e.task_id ?? '')
          return { result: { message: 'stopped', task_id: e.task_id ?? '', task_type: 'local_bash' } }
        }
        return backgrounded('task-s')
      })
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Runaway', tool_use_id: 'run', run_in_background: true })

      const ui = await mountPane($)
      await ui.press({ key: 'stop-run' })
      expect(stopped).toEqual(['task-s'])
      expect(await ui.find({ key: 'stop-run' })).toBeUndefined()
      expect(await ui.find({ text: /■/ })).toBeDefined()
    })

    test(`filters to only ongoing tasks (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', (_$, e) =>
        e.tool === 'TaskStop'
          ? { result: { message: 'stopped' } }
          : backgrounded(e.tool_use_id === 'done' ? 'task-done' : 'task-live'),
      )
      await $.tool.call({ tool: 'Bash', command: 'make', description: 'Finished build', tool_use_id: 'done', run_in_background: true })
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Still going', tool_use_id: 'live', run_in_background: true })
      // The first task ends.
      await $.tool.call({ tool: 'TaskStop', task_id: 'task-done', tool_use_id: 'stop' })

      const ui = await mountPane($)
      expect(await ui.find({ text: /Finished build/ })).toBeDefined()

      await ui.press({ key: 'filter' })
      expect(await ui.find({ text: /Finished build/ })).toBeUndefined()
      expect(await ui.find({ text: /Still going/ })).toBeDefined()
      expect(await ui.find({ text: /Show finished \(1\)/ })).toBeDefined()

      await ui.press({ key: 'filter' })
      expect(await ui.find({ text: /Finished build/ })).toBeDefined()
    })
  }
})
