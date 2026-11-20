import * as vscode from 'vscode'

import { categorizeTargets, handleFolderScanning } from '../utils'
import { Command, CommandDependencies } from './types'

interface ResourceStateLike {
  resourceUri: vscode.Uri
}

interface ResourceGroupLike {
  resourceStates: readonly ResourceStateLike[]
}

interface ResourceFolderLike {
  resources: readonly ResourceStateLike[]
}

interface EditorContextLike {
  uris?: unknown[]
  tabs?: unknown[]
  selectedEditors?: unknown[]
}

interface OpenTabQuickPickItem extends vscode.QuickPickItem {
  uri: vscode.Uri
}

export function getAddFileContextMenuCommands(deps: CommandDependencies): Command[] {
  const { stackProvider, ignoreManager } = deps.services

  const addTargetsToStack = async (targets: vscode.Uri[]): Promise<void> => {
    if (targets.length === 0) {
      vscode.window.showWarningMessage('No selection found.')
      return
    }

    const { files, folders } = await categorizeTargets(targets)

    if (files.length === 0 && folders.length === 0) {
      vscode.window.showWarningMessage('No readable files found in selection (deleted files are skipped).')
      return
    }

    if (files.length > 0) {
      await stackProvider.addFiles(files)
    }

    if (folders.length > 0) {
      await handleFolderScanning(folders, stackProvider, ignoreManager)
    } else if (files.length > 0) {
      vscode.window.setStatusBarMessage(`Added ${files.length} file(s).`, 2000)
    }
  }

  return [
    {
      id: 'aiContextStacker.addFileToStack',
      execute: async (...args: unknown[]) => {
        const targets = resolveTargets(...args)
        await addTargetsToStack(targets)
      },
    },
    {
      id: 'aiContextStacker.addFileToStackFromTab',
      execute: async (...args: unknown[]) => {
        let targets = resolveTargets(...args)

        if (targets.length === 1) {
          const selectedTabs = await getMultiSelectedEditorTabUris(targets[0])
          if (selectedTabs.length > 1) {
            targets = deduplicateUris(selectedTabs)
          }
        }

        await addTargetsToStack(targets)
      },
    },
    {
      id: 'aiContextStacker.addSelectedOpenTabs',
      execute: async (clickedUri?: vscode.Uri) => {
        const openUris = collectOpenFileTabUris()
        if (openUris.length === 0) {
          void vscode.window.showInformationMessage('No open file tabs found.')
          return
        }

        const clickedKey = isUri(clickedUri) ? clickedUri.toString() : undefined
        const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1

        const items: OpenTabQuickPickItem[] = openUris.map((uri) => {
          const relPath = vscode.workspace.asRelativePath(uri, isMultiRoot)
          const label = uri.path.split('/').pop() || relPath
          const alreadyStaged = stackProvider.hasTrackedPath(uri)
          return {
            label,
            description: relPath,
            detail: alreadyStaged ? '$(check) Already in current track' : undefined,
            picked: clickedKey ? uri.toString() === clickedKey : !alreadyStaged,
            uri,
          }
        })

        const selected = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select open tabs to add to Stackr',
          title: 'Add Open Tabs to Stackr',
          matchOnDescription: true,
        })

        if (!selected || selected.length === 0) {
          return
        }

        const uris = selected.map((item) => item.uri)
        const added = await stackProvider.addFiles(uris)
        if (added) {
          vscode.window.setStatusBarMessage(`Added ${uris.length} open tab(s) to Stackr.`, 2500)
        } else {
          void vscode.window.showInformationMessage('Selected tabs are already in the current stack.')
        }
      },
    },
  ]
}

export async function getMultiSelectedEditorTabUris(anchor: vscode.Uri): Promise<vscode.Uri[]> {
  if (anchor.scheme !== 'file') {
    return []
  }

  const previousClipboard = await vscode.env.clipboard.readText()
  const sentinel = `__stackr_tab_selection_${Date.now()}_${Math.random()}__`

  try {
    await vscode.env.clipboard.writeText(sentinel)
    await vscode.commands.executeCommand('copyFilePath', anchor)

    const copied = await vscode.env.clipboard.readText()
    const rawPaths = parseCopiedTabPaths(copied, sentinel, anchor.fsPath)

    return rawPaths.map((p) => vscode.Uri.file(p))
  } catch {
    return []
  } finally {
    try {
      await vscode.env.clipboard.writeText(previousClipboard)
    } catch {
      // Clipboard restoration is best-effort.
    }
  }
}

export function parseCopiedTabPaths(copied: string, sentinel: string, anchorFsPath: string): string[] {
  if (!copied || copied === sentinel) {
    return []
  }

  const rawPaths = copied
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const pathsByNormalized = new Map<string, string>()
  for (const rawPath of rawPaths) {
    pathsByNormalized.set(normalizeFsPath(rawPath), rawPath)
  }

  const uniqueNormalized = [...pathsByNormalized.keys()]
  if (uniqueNormalized.length <= 1) {
    return []
  }

  const anchorPath = normalizeFsPath(anchorFsPath)
  if (!uniqueNormalized.includes(anchorPath)) {
    return []
  }

  return [...pathsByNormalized.values()]
}

export function resolveTargets(...args: unknown[]): vscode.Uri[] {
  const collected: vscode.Uri[] = []

  // Explorer / Open Editors multi-select passes (clickedUri, selectedUris[]).
  // When second arg is an array of URIs/targets, prefer it over arg[0] alone to preserve exact selection.
  if (args.length >= 2 && Array.isArray(args[1]) && args[1].length > 0) {
    extractUrisFromValue(args[1], collected)
  } else {
    for (const arg of args) {
      extractUrisFromValue(arg, collected)
    }
  }

  const unique = deduplicateUris(collected)
  if (unique.length > 0) {
    return unique
  }

  if (vscode.window.activeTextEditor) {
    return [vscode.window.activeTextEditor.document.uri]
  }

  return []
}

function extractUrisFromValue(value: unknown, out: vscode.Uri[]): void {
  if (!value) {
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractUrisFromValue(item, out)
    }
    return
  }

  if (isUri(value)) {
    out.push(value)
    return
  }

  if (typeof value !== 'object') {
    return
  }

  const obj = value as Partial<ResourceStateLike & ResourceGroupLike & ResourceFolderLike & EditorContextLike> & {
    uri?: unknown
    tab?: unknown
    input?: unknown
    modified?: unknown
  }

  if (obj.tab && typeof obj.tab === 'object') {
    extractUrisFromValue(obj.tab, out)
  }

  if (isUri(obj.resourceUri)) {
    out.push(obj.resourceUri)
  }

  if (isUri(obj.uri)) {
    out.push(obj.uri)
  }

  if (isUri(obj.modified)) {
    out.push(obj.modified)
  }

  if (obj.input) {
    extractUrisFromValue(obj.input, out)
  }

  if (Array.isArray(obj.resourceStates)) {
    for (const state of obj.resourceStates) {
      extractUrisFromValue(state, out)
    }
  }

  if (Array.isArray(obj.resources)) {
    for (const state of obj.resources) {
      extractUrisFromValue(state, out)
    }
  }

  if (Array.isArray(obj.uris)) {
    for (const item of obj.uris) {
      extractUrisFromValue(item, out)
    }
  }

  if (Array.isArray(obj.tabs)) {
    for (const tab of obj.tabs) {
      extractUrisFromValue(tab, out)
    }
  }

  if (Array.isArray(obj.selectedEditors)) {
    for (const editor of obj.selectedEditors) {
      extractUrisFromValue(editor, out)
    }
  }
}

function normalizeFsPath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  return process.platform === 'win32' || process.platform === 'darwin' ? normalized.toLowerCase() : normalized
}

function isUri(value: unknown): value is vscode.Uri {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (value instanceof vscode.Uri) {
    return true
  }
  const candidate = value as Partial<vscode.Uri>
  return (
    typeof candidate.scheme === 'string' &&
    typeof candidate.fsPath === 'string' &&
    typeof candidate.toString === 'function'
  )
}

function deduplicateUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>()
  const result: vscode.Uri[] = []

  for (const uri of uris) {
    const key = uri.scheme === 'file' ? normalizeFsPath(uri.fsPath) : uri.toString()
    if (!seen.has(key)) {
      seen.add(key)
      result.push(uri)
    }
  }

  return result
}

function collectOpenFileTabUris(): vscode.Uri[] {
  const uris: vscode.Uri[] = []

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
        uris.push(tab.input.uri)
      } else if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'file') {
        uris.push(tab.input.modified)
      }
    }
  }

  return deduplicateUris(uris)
}
