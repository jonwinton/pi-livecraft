#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npmCommand, ['run', 'dev'], {
  cwd: projectRoot,
  // Node refuses to spawn .cmd files without a shell (EINVAL); the arguments are constants.
  shell: process.platform === 'win32',
  stdio: 'inherit',
})

child.once('error', (error) => {
  console.error(`Could not start npm run dev: ${error.message}`)
  process.exitCode = 1
})

child.once('close', (code) => {
  if (code !== null) process.exitCode = code
})
