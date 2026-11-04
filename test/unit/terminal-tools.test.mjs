import assert from 'node:assert/strict'
import test from 'node:test'

import { createShellTools } from '../../lib/terminal/tools.js'

const HOST = { id: 'config:testbox', name: 'testbox', host: '127.0.0.1' }
const EXEC = { agent: { id: 'conversation-1' }, signal: new AbortController().signal }

test('remote_shell_open reports when its PTY is shared with the native terminal', async () => {
  const calls = []
  const tools = createShellTools({
    defineTool: (definition) => definition,
    config: { terminalMaxReadBytes: 4_096 },
    manager: {
      async open(request) {
        calls.push(request)
        return {
          sessionId: 'remote-shell-1',
          host: HOST.name,
          status: { kind: 'running' },
          motd: 'ready',
          sharedTerminal: true,
        }
      },
    },
    approval: { async authorize() { return { allowed: true } } },
    hosts: {
      async find() { return HOST },
      isAllowed() { return true },
      isReadonly() { return false },
    },
  })
  const openTool = tools.find((tool) => tool.name === 'remote_shell_open')
  assert.ok(openTool)

  const result = await openTool.execute({ host: HOST.name }, EXEC)
  assert.equal(result.sharedTerminal, true)
  assert.equal(calls.length, 1)
  const rendered = openTool.output.render({}, result)[0].text
  assert.match(rendered, /shared with this conversation's DSH terminal/u)
  assert.match(rendered, /ready/u)
})
