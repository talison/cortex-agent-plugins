import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the MCP server reports the version the plugin ships', () => {
  // server.ts hard-coded fork.7 while package.json and plugin.json said fork.9
  // (2026-11-16 audit, finding 13); it now reads package.json.
  const pkg = JSON.parse(read('../package.json')).version
  expect(JSON.parse(read('../.claude-plugin/plugin.json')).version).toBe(pkg)
  const server = read('../server.ts')
  expect(server).toContain("{ name: 'telegram', version: PLUGIN_VERSION }")
  expect(server).not.toMatch(/version: '\d+\.\d+\.\d+[^']*'/)
})
