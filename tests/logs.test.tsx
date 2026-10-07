import { describe, expect, mock, test } from 'claude-code/testing'

import { notificationsIn, outputPathIn, toLines } from '../hooks/register'

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
    test(`collapses and expands an entry (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', () => ({ result: { stdout: 'line one' + String.fromCharCode(10) + 'line two', stderr: '', interrupted: false } }))
      await $.tool.call({ tool: 'Bash', command: 'echo', description: 'Two lines', tool_use_id: 't2' })

      const ui = await $.ui.mount({
        plugin: 'script-logs',
        surface,
        component: 'Pane',
        requestId: 'script-logs',
        props: { title: 'Script logs' } as never,
      })
      expect(await ui.find({ text: /line two/ })).toBeDefined()

      await ui.press({ key: 'toggle-t2' })
      expect(await ui.find({ text: /line two/ })).toBeUndefined()
      expect(await ui.find({ text: /2 lines/ })).toBeDefined()

      await ui.press({ key: 'toggle-t2' })
      expect(await ui.find({ text: /line two/ })).toBeDefined()
    })

    test(`filters to only ongoing scripts (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', (_$, e) =>
        e.tool_use_id === 'bg'
          ? { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg' } }
          : { result: { stdout: 'all done', stderr: '', interrupted: false } },
      )
      await $.tool.call({ tool: 'Bash', command: 'echo', description: 'Finished one', tool_use_id: 'fg' })
      await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Still going', tool_use_id: 'bg', run_in_background: true })

      const ui = await $.ui.mount({
        plugin: 'script-logs',
        surface,
        component: 'Pane',
        requestId: 'script-logs',
        props: { title: 'Script logs' } as never,
      })
      expect(await ui.find({ text: /Finished one/ })).toBeDefined()

      await ui.press({ key: 'filter' })
      expect(await ui.find({ text: /Finished one/ })).toBeUndefined()
      expect(await ui.find({ text: /Still going/ })).toBeDefined()
      expect(await ui.find({ text: /Show finished \(1\)/ })).toBeDefined()

      await ui.press({ key: 'filter' })
      expect(await ui.find({ text: /Finished one/ })).toBeDefined()
    })

    test(`shows a Bash call's output in the pane (${surface})`, async ($, on) => {
      mock.clock(on)
      on('tool.call', () => ({
        result: { stdout: 'hello from the script', stderr: '', interrupted: false },
      }))

      await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'Say hello', tool_use_id: 't1' })

      const ui = await $.ui.mount({
        plugin: 'script-logs',
        surface,
        component: 'Pane',
        requestId: 'script-logs',
        props: { title: 'Script logs' } as never,
      })
      expect(await ui.find({ text: /hello from the script/ })).toBeDefined()
      expect(await ui.find({ text: /Say hello/ })).toBeDefined()
    })
  }
})
