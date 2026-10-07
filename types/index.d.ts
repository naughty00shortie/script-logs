export type LogStatus = 'running' | 'background' | 'done' | 'failed' | 'stopped'

export type LogEntry = {
  id: string
  tool: string
  title: string
  command: string
  status: LogStatus
  lines: string[]
  startedAt: number
  agentId?: string
  taskId?: string
  outputPath?: string
  isCollapsed?: boolean
}

export type LogView = 'overview' | 'follow'

declare module 'claude-code' {
  interface PluginState {
    'script-logs': { entries: LogEntry[]; view: LogView; onlyLive: boolean }
  }
}
