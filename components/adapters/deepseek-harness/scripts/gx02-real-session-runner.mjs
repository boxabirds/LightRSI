/**
 * Start the GX-02 verifier through the checked-out DSH tsconfig.
 *
 * DSH's source packages rely on its workspace path aliases. Running the
 * verifier through this tiny launcher prevents Node from accidentally mixing
 * the adapter's dependency graph with DSH's built-package graph.
 */

import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const checkoutArgument = args.find(value => value.startsWith('--dsh-checkout='))
if (checkoutArgument === undefined) {
  throw new Error('GX-02 requires --dsh-checkout=<absolute path to deepseek-harness>')
}

const checkout = resolve(checkoutArgument.slice('--dsh-checkout='.length))
const tsxCli = join(checkout, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const tsconfig = join(checkout, 'tsconfig.json')
await Promise.all([access(tsxCli), access(tsconfig)])

const script = join(dirname(fileURLToPath(import.meta.url)), 'gx02-real-session.ts')
const child = spawn(process.execPath, [tsxCli, '--tsconfig', tsconfig, script, ...args], {
  stdio: 'inherit',
})

const exitCode = await new Promise(resolveChild => {
  child.once('error', () => resolveChild(1))
  child.once('exit', code => resolveChild(code ?? 1))
})
process.exitCode = exitCode
