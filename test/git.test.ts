import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  commitChanges,
  discardChanges,
  discardFileChanges,
  getGitFileDiff,
  getGitSnapshot,
  mergeNumstats,
  parseGitStatus,
  pushCommits,
  resetGitCommit,
  revertGitCommit,
} from '../server/features/git/git.ts'

// macOS exposes the temporary directory through a symlink; compare canonical paths.
const tmpdir = (): string => realpathSync(osTmpdir())

const execFile = promisify(execFileCallback)

test('parses Git status and combines staged and unstaged line counts', () => {
  assert.deepEqual(parseGitStatus(' M src/App.tsx\0?? new-file.ts\0R  renamed.ts\0old-name.ts\0'), [
    { path: 'src/App.tsx', status: 'modified' },
    { path: 'new-file.ts', status: 'added' },
    { path: 'renamed.ts', status: 'renamed' },
  ])

  const counts = mergeNumstats('2\t1\tsrc/App.tsx\0', '3\t0\tsrc/App.tsx\0' + '4\t0\tnew-file.ts\0')

  assert.deepEqual(counts.get('src/App.tsx'), { additions: 5, deletions: 1 })
  assert.deepEqual(counts.get('new-file.ts'), { additions: 4, deletions: 0 })
})

test('uses the destination path for renamed numstat records and preserves binary counts', () => {
  const counts = mergeNumstats('-\t-\t\0old-name.ts\0renamed.ts\0')

  assert.deepEqual(counts.get('renamed.ts'), { additions: null, deletions: null })
})

test('reports untracked files and their line additions from a worktree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await writeFile(join(directory, 'new-file.ts'), 'first line\nsecond line\n')

    const snapshot = await getGitSnapshot(directory)

    assert.equal(snapshot.repository, true)
    assert.equal(snapshot.root?.replaceAll('\\', '/'), directory.replaceAll('\\', '/'))
    assert.deepEqual(snapshot.files, [{
      path: 'new-file.ts',
      status: 'added',
      additions: 2,
      deletions: 0,
    }])
    assert.deepEqual(snapshot.commits, [])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('returns diffs for modified and untracked files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await writeFile(join(directory, 'tracked.ts'), 'before\n')
    await execFile('git', ['add', 'tracked.ts'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial commit'], { cwd: directory })
    await writeFile(join(directory, 'tracked.ts'), 'after\n')
    await writeFile(join(directory, 'new.ts'), 'new file\n')

    const modified = await getGitFileDiff(directory, 'tracked.ts')
    const added = await getGitFileDiff(directory, 'new.ts')

    assert.match(modified.diff, /-before\n\+after/)
    assert.match(added.diff, /\+new file/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('reports, resets, and reverts unpushed commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  const remote = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-remote-'))
  try {
    await execFile('git', ['init', '--bare', '--quiet'], { cwd: remote })
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await writeFile(join(directory, 'tracked.ts'), 'initial\n')
    await execFile('git', ['add', 'tracked.ts'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial commit'], { cwd: directory })
    await execFile('git', ['branch', '-M', 'main'], { cwd: directory })
    await execFile('git', ['remote', 'add', 'origin', remote], { cwd: directory })
    await execFile('git', ['push', '--quiet', '--set-upstream', 'origin', 'main'], {
      cwd: directory,
    })
    await writeFile(join(directory, 'tracked.ts'), 'initial\nchanged\n')
    await writeFile(join(directory, 'unpushed.ts'), 'local only\n')
    await execFile('git', ['add', 'tracked.ts', 'unpushed.ts'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Local commit'], { cwd: directory })
    await writeFile(join(directory, 'second.ts'), 'second commit\n')
    await execFile('git', ['add', 'second.ts'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Second local commit'], { cwd: directory })

    const snapshot = await getGitSnapshot(directory)

    assert.equal(snapshot.ahead, 2)
    assert.deepEqual(snapshot.commits.map(({ hash: _hash, ...commit }) => commit), [
      {
        subject: 'Second local commit',
        files: [{ path: 'second.ts', status: 'added', additions: 1, deletions: 0 }],
      },
      {
        subject: 'Local commit',
        files: [
          { path: 'tracked.ts', status: 'modified', additions: 1, deletions: 0 },
          { path: 'unpushed.ts', status: 'added', additions: 1, deletions: 0 },
        ],
      },
    ])
    assert.match(snapshot.commits[0]?.hash ?? '', /^[0-9a-f]{40}$/)

    const commit = snapshot.commits.find(({ subject }) => subject === 'Local commit')
    const diff = await getGitFileDiff(directory, 'tracked.ts', commit?.hash)
    assert.match(diff.diff, /\+changed/)

    await assert.rejects(
      resetGitCommit(directory, commit?.hash ?? ''),
      /Only the latest unpushed commit/,
    )
    await resetGitCommit(directory, snapshot.commits[0]?.hash ?? '')
    const reset = await getGitSnapshot(directory)
    const tracked = await execFile('git', ['show', 'HEAD:tracked.ts'], { cwd: directory })

    assert.equal(reset.ahead, 1)
    assert.deepEqual(reset.commits.map(({ subject }) => subject), ['Local commit'])
    assert.deepEqual(reset.files.map(({ path, status }) => ({ path, status })), [
      { path: 'second.ts', status: 'added' },
    ])
    assert.equal(tracked.stdout, 'initial\nchanged\n')

    await execFile('git', ['add', '-A'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Restored local changes'], { cwd: directory })
    const restored = await getGitSnapshot(directory)
    await revertGitCommit(directory, restored.commits[0]?.hash ?? '')
    const reverted = await getGitSnapshot(directory)

    assert.equal(reverted.ahead, 3)
    assert.equal(reverted.files.length, 0)
    assert.match(reverted.commits[0]?.subject ?? '', /^Revert "Restored local changes"$/)
  } finally {
    await rm(directory, { force: true, recursive: true })
    await rm(remote, { force: true, recursive: true })
  }
})

test('commits without pushing, pushes separately, and discards changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  const remote = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-remote-'))
  try {
    await execFile('git', ['init', '--bare', '--quiet'], { cwd: remote })
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await writeFile(join(directory, 'initial.ts'), 'hello\n')
    await execFile('git', ['add', 'initial.ts'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial'], { cwd: directory })
    await execFile('git', ['branch', '-M', 'main'], { cwd: directory })
    await execFile('git', ['remote', 'add', 'origin', remote], { cwd: directory })
    await execFile('git', ['push', '--quiet', '--set-upstream', 'origin', 'main'], {
      cwd: directory,
    })

    // Commit only — does not push
    await writeFile(join(directory, 'initial.ts'), 'hello\nworld\n')
    await writeFile(join(directory, 'new.ts'), 'new file\n')
    await commitChanges(directory, 'Local only')

    let snapshot = await getGitSnapshot(directory)
    assert.equal(snapshot.files.length, 0)
    assert.equal(snapshot.ahead, 1)
    assert.equal(snapshot.commits[0].subject, 'Local only')

    // Push the commit
    const pushResult = await pushCommits(directory)
    assert.equal(pushResult.pushed, true)

    snapshot = await getGitSnapshot(directory)
    assert.equal(snapshot.ahead, 0)

    // Discard uncommitted changes including new files
    await writeFile(join(directory, 'modified.ts'), 'dirty\n')
    await writeFile(join(directory, 'untracked.ts'), 'new\n')
    await execFile('git', ['add', 'modified.ts'], { cwd: directory })

    let dirty = await getGitSnapshot(directory)
    assert.equal(dirty.files.length, 2)

    await discardChanges(directory)

    dirty = await getGitSnapshot(directory)
    assert.equal(dirty.files.length, 0)
  } finally {
    await rm(directory, { force: true, recursive: true })
    await rm(remote, { force: true, recursive: true })
  }
})

test('discards only the selected file, including renamed and untracked files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await writeFile(join(directory, 'first.ts'), 'first\n')
    await writeFile(join(directory, 'second.ts'), 'second\n')
    await execFile('git', ['add', '.'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial'], { cwd: directory })
    await writeFile(join(directory, 'first.ts'), 'changed\n')
    await writeFile(join(directory, 'second.ts'), 'also changed\n')
    await writeFile(join(directory, 'new.ts'), 'new\n')

    await discardFileChanges(directory, 'first.ts')
    let snapshot = await getGitSnapshot(directory)
    assert.deepEqual(snapshot.files.map(({ path }) => path), ['second.ts', 'new.ts'])
    assert.equal(
      (await readFile(join(directory, 'first.ts'), 'utf8')).replaceAll('\r\n', '\n'),
      'first\n',
    )

    await discardFileChanges(directory, 'new.ts')
    await execFile('git', ['checkout', '--', 'second.ts'], { cwd: directory })
    await execFile('git', ['mv', 'second.ts', 'renamed.ts'], { cwd: directory })
    await discardFileChanges(directory, 'renamed.ts')
    snapshot = await getGitSnapshot(directory)
    assert.equal(snapshot.files.length, 0)
    assert.equal(
      (await readFile(join(directory, 'second.ts'), 'utf8')).replaceAll('\r\n', '\n'),
      'second\n',
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('diffs and discards root-relative paths from a workspace subdirectory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  const workspace = join(directory, 'sub')
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await mkdir(workspace)
    await writeFile(join(workspace, 'file.ts'), 'first\n')
    await execFile('git', ['add', '.'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial'], { cwd: directory })
    await writeFile(join(workspace, 'file.ts'), 'changed\n')
    await writeFile(join(workspace, 'new.ts'), 'one\ntwo\n')

    const snapshot = await getGitSnapshot(workspace)
    assert.deepEqual(snapshot.files, [
      { path: 'sub/file.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'sub/new.ts', status: 'added', additions: 2, deletions: 0 },
    ])
    assert.match((await getGitFileDiff(workspace, 'sub/file.ts')).diff, /\+changed/)
    assert.match((await getGitFileDiff(workspace, 'sub/new.ts')).diff, /\+two/)

    await discardFileChanges(workspace, 'sub/file.ts')
    await discardFileChanges(workspace, 'sub/new.ts')
    assert.deepEqual((await getGitSnapshot(workspace)).files, [])
    assert.equal(
      (await readFile(join(workspace, 'file.ts'), 'utf8')).replaceAll('\r\n', '\n'),
      'first\n',
    )
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('discards untracked files in a repository without commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await writeFile(join(directory, 'new.ts'), 'new\n')
    await discardChanges(directory)
    assert.deepEqual((await getGitSnapshot(directory)).files, [])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('treats a discarded filename literally rather than as a pathspec pattern', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await writeFile(join(directory, '*.ts'), 'pattern\n')
    await writeFile(join(directory, 'keep.ts'), 'keep\n')

    await discardFileChanges(directory, '*.ts')
    assert.deepEqual((await getGitSnapshot(directory)).files.map(({ path }) => path), ['keep.ts'])
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('does not run repository-configured helpers while reading status or diffs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await writeFile(join(directory, '.gitattributes'), '*.txt diff=helper\n')
    await writeFile(join(directory, 'file.txt'), 'first\n')
    await execFile('git', ['add', '.'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial'], { cwd: directory })
    const helper = join(directory, '.git', 'helper.sh')
    await writeFile(helper, `#!/bin/sh\necho "$0 $*" >> "${join(directory, '.git', 'ran.log')}"\n`)
    await chmod(helper, 0o755)
    for (const key of ['core.fsmonitor', 'diff.external', 'diff.helper.textconv']) {
      await execFile('git', ['config', key, helper], { cwd: directory })
    }
    await writeFile(join(directory, 'file.txt'), 'changed\n')

    const snapshot = await getGitSnapshot(directory)
    const { diff } = await getGitFileDiff(directory, 'file.txt')

    assert.deepEqual(snapshot.files, [
      { path: 'file.txt', status: 'modified', additions: 1, deletions: 1 },
    ])
    assert.match(diff, /^-first\n\+changed$/m)
    await assert.rejects(readFile(join(directory, '.git', 'ran.log'), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test(
  'counts many untracked files within a small open-file limit',
  { skip: process.platform === 'win32', timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
    try {
      await execFile('git', ['init', '--quiet'], { cwd: directory })
      for (let index = 0; index < 600; index += 1) {
        await writeFile(join(directory, `file-${index}.txt`), 'line\n')
      }
      const script = `import('${
        join(process.cwd(), 'server/features/git/git.ts')
      }').then(async ({ getGitSnapshot }) => { const { files } = await getGitSnapshot(${
        JSON.stringify(directory)
      }); console.log(files.filter(({ additions }) => additions === 1).length) })`
      const { stdout } = await execFile('sh', [
        '-c',
        `ulimit -n 256 && exec "${process.execPath}" --input-type=module -e "$0"`,
        script,
      ])
      assert.equal(stdout.trim(), '600')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  },
)

test('rejects commit without changes or message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await assert.rejects(commitChanges(directory, 'Nothing'), /no changes/)
    await writeFile(join(directory, 'file.ts'), 'content\n')
    await assert.rejects(commitChanges(directory, '  '), /commit message/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('rejects push without ahead commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-livecraft-git-'))
  try {
    await execFile('git', ['init', '--quiet'], { cwd: directory })
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: directory })
    await writeFile(join(directory, 'file.ts'), 'content\n')
    await execFile('git', ['add', 'file.ts'], { cwd: directory })
    await execFile('git', ['commit', '--quiet', '-m', 'Initial'], { cwd: directory })
    await assert.rejects(pushCommits(directory), /no commits to push/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})
