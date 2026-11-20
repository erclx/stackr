import * as cp from 'child_process'
import * as path from 'path'
import * as vscode from 'vscode'

import { StackProvider } from '../providers'
import { categorizeTargets, ErrorHandler, Logger } from '../utils'
import { Command, CommandDependencies } from './types'

export function getAddGitFilesCommands(deps: CommandDependencies): Command[] {
  const { stackProvider } = deps.services

  return [
    {
      id: 'aiContextStacker.addGitChangedFiles',
      execute: ErrorHandler.safeExecute('Add All Git Changed Files', async () => {
        await handleAddGitStatusFiles(stackProvider, 'all')
      }),
    },
    {
      id: 'aiContextStacker.addGitStagedFiles',
      execute: ErrorHandler.safeExecute('Add Git Staged Files', async () => {
        await handleAddGitStatusFiles(stackProvider, 'staged')
      }),
    },
    {
      id: 'aiContextStacker.addGitBranchDiffFiles',
      execute: ErrorHandler.safeExecute('Add Git Files Changed vs Branch', async () => {
        await handleAddGitBranchDiffFiles(stackProvider)
      }),
    },
  ]
}

async function handleAddGitStatusFiles(provider: StackProvider, mode: 'all' | 'staged'): Promise<void> {
  const roots = getWorkspaceRoots()
  if (roots.length === 0) {
    void vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const label = mode === 'staged' ? 'Git staged' : 'Git changed'
  const candidateUris: vscode.Uri[] = []
  let foundGitRepo = false

  for (const root of roots) {
    const repoRoot = await resolveGitTopLevel(root)
    if (!repoRoot) {
      continue
    }
    foundGitRepo = true

    const stdout = await execGit(repoRoot, ['status', '--porcelain=v1', '-z'])
    if (!stdout) {
      continue
    }

    const relPaths = parseGitPorcelainZ(stdout, mode)
    for (const rel of relPaths) {
      candidateUris.push(vscode.Uri.file(path.join(repoRoot, rel)))
    }
  }

  if (!foundGitRepo) {
    void vscode.window.showWarningMessage('No Git repository found in the current workspace.')
    return
  }

  await stageResolvedGitUris(provider, candidateUris, label)
}

async function handleAddGitBranchDiffFiles(provider: StackProvider): Promise<void> {
  const roots = getWorkspaceRoots()
  if (roots.length === 0) {
    void vscode.window.showWarningMessage('Open a workspace folder first.')
    return
  }

  const repoRoots = new Set<string>()
  for (const root of roots) {
    const top = await resolveGitTopLevel(root)
    if (top) {
      repoRoots.add(top)
    }
  }

  if (repoRoots.size === 0) {
    void vscode.window.showWarningMessage('No Git repository found in the current workspace.')
    return
  }

  const primaryRepo = Array.from(repoRoots)[0]
  const branchOutput = await execGit(primaryRepo, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ])

  const branches = prioritizeDefaultBranches(
    branchOutput
      .split(/\r?\n/)
      .map((b) => b.trim())
      .filter((b) => b.length > 0 && !b.endsWith('/HEAD')),
  )

  if (branches.length === 0) {
    void vscode.window.showWarningMessage('No Git branches found to compare against.')
    return
  }

  const selectedBranch = await vscode.window.showQuickPick(branches, {
    placeHolder: 'Select base branch to diff against (includes committed + working tree changes)',
    title: 'Add Git Files Changed vs Branch',
  })

  if (!selectedBranch) {
    return
  }

  const candidateUris: vscode.Uri[] = []

  for (const repoRoot of repoRoots) {
    const mergeBase = (await execGit(repoRoot, ['merge-base', selectedBranch, 'HEAD'])).trim()
    const diffTarget = mergeBase || selectedBranch

    const diffStdout = await execGit(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', '-z', diffTarget])
    for (const rel of parseGitNameOnlyZ(diffStdout)) {
      candidateUris.push(vscode.Uri.file(path.join(repoRoot, rel)))
    }

    // Also include untracked files so newly created feature files aren't missed
    const untrackedStdout = await execGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    for (const rel of parseGitNameOnlyZ(untrackedStdout)) {
      candidateUris.push(vscode.Uri.file(path.join(repoRoot, rel)))
    }
  }

  await stageResolvedGitUris(provider, candidateUris, `changed vs ${selectedBranch}`)
}

async function stageResolvedGitUris(
  provider: StackProvider,
  candidateUris: vscode.Uri[],
  description: string,
): Promise<void> {
  const uniqueUris = deduplicateUris(candidateUris)
  if (uniqueUris.length === 0) {
    void vscode.window.showInformationMessage(`No ${description} files found.`)
    return
  }

  const { files } = await categorizeTargets(uniqueUris)
  if (files.length === 0) {
    void vscode.window.showInformationMessage(`No existing ${description} files found (deleted files were skipped).`)
    return
  }

  const added = await provider.addFiles(files)
  if (added) {
    vscode.window.setStatusBarMessage(`Added ${files.length} ${description} file(s) to Stackr.`, 3000)
  } else {
    void vscode.window.showInformationMessage(`All ${description} files are already in the current stack.`)
  }
}

export function parseGitPorcelainZ(stdout: string, mode: 'all' | 'staged'): string[] {
  if (!stdout) {
    return []
  }

  const entries = stdout.split('\0')
  const results: string[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) {
      continue
    }

    const indexStatus = entry[0]
    const workTreeStatus = entry[1]
    const filePath = entry.slice(3)

    // In `git status --porcelain=v1 -z`, renames/copies emit `XY new_path\0old_path\0`
    if (indexStatus === 'R' || indexStatus === 'C' || workTreeStatus === 'R' || workTreeStatus === 'C') {
      i++
    }

    if (mode === 'staged') {
      const isStaged = indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!' && indexStatus !== 'D'
      if (isStaged && workTreeStatus !== 'D') {
        results.push(filePath)
      }
    } else {
      const isIgnored = indexStatus === '!' && workTreeStatus === '!'
      const isDeleted = workTreeStatus === 'D' || (indexStatus === 'D' && workTreeStatus === ' ')
      if (!isIgnored && !isDeleted) {
        results.push(filePath)
      }
    }
  }

  return results
}

export function parseGitNameOnlyZ(stdout: string): string[] {
  if (!stdout) {
    return []
  }
  return stdout.split('\0').filter((p) => p.length > 0)
}

function prioritizeDefaultBranches(branches: string[]): string[] {
  const priority = ['main', 'master', 'origin/main', 'origin/master', 'develop', 'origin/develop']
  const unique = Array.from(new Set(branches))
  return unique.sort((a, b) => {
    const pa = priority.indexOf(a)
    const pb = priority.indexOf(b)
    if (pa !== -1 && pb !== -1) {
      return pa - pb
    }
    if (pa !== -1) {
      return -1
    }
    if (pb !== -1) {
      return 1
    }
    return a.localeCompare(b)
  })
}

function getWorkspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath)
}

async function resolveGitTopLevel(cwd: string): Promise<string | undefined> {
  const out = (await execGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
  return out || undefined
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        Logger.debug(`git ${args.join(' ')} failed in ${cwd}: ${error.message}`)
        resolve('')
        return
      }
      resolve(stdout)
    })
  })
}

function deduplicateUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>()
  const out: vscode.Uri[] = []
  for (const uri of uris) {
    const key = uri.toString()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(uri)
    }
  }
  return out
}
