import * as vscode from 'vscode'

import { StackTreeItem, StagedFile } from '../models'
import { TrackManager } from '../providers'
import { getDescendantFiles } from '../services'
import { ErrorHandler } from '../utils'
import { Command, CommandDependencies } from './types'

interface TargetTrackPick extends vscode.QuickPickItem {
  trackId?: string
  createNew?: boolean
}

export function getTransferFilesCommands(deps: CommandDependencies): Command[] {
  return [
    {
      id: 'aiContextStacker.copyFilesToTrack',
      execute: (item?: StackTreeItem, selectedItems?: StackTreeItem[]) => {
        return ErrorHandler.safeExecute('Copy Files to Track', () =>
          handleTransferFiles(deps, item, selectedItems, 'copy'),
        )()
      },
    },
    {
      id: 'aiContextStacker.moveFilesToTrack',
      execute: (item?: StackTreeItem, selectedItems?: StackTreeItem[]) => {
        return ErrorHandler.safeExecute('Move Files to Track', () =>
          handleTransferFiles(deps, item, selectedItems, 'move'),
        )()
      },
    },
  ]
}

async function handleTransferFiles(
  deps: CommandDependencies,
  item: StackTreeItem | undefined,
  selectedItems: StackTreeItem[] | undefined,
  mode: 'copy' | 'move',
): Promise<void> {
  const { trackManager } = deps.services
  const { filesView } = deps.views

  const files = resolveSelectedFiles(item, selectedItems, filesView)
  if (files.length === 0) {
    void vscode.window.showWarningMessage(`Please select files or folders to ${mode}.`)
    return
  }

  const activeTrack = trackManager.getActiveTrack()
  const targetTrackId = await pickOrCreateTargetTrack(trackManager, activeTrack.id, mode, files.length)
  if (!targetTrackId) {
    return
  }

  const targetTrack = trackManager.getTrackById(targetTrackId)
  const targetName = targetTrack?.name ?? 'target track'

  if (mode === 'copy') {
    const result = trackManager.copyFilesToTrack(files, targetTrackId)
    if (result.transferredCount === 0 && result.skippedDuplicates > 0) {
      void vscode.window.showInformationMessage(`All selected files are already in "${targetName}".`)
      return
    }
    const suffix = result.skippedDuplicates > 0 ? ` (${result.skippedDuplicates} already present)` : ''
    vscode.window.setStatusBarMessage(`Copied ${result.transferredCount} file(s) to "${targetName}"${suffix}.`, 3000)
    return
  }

  const result = trackManager.moveFilesToTrack(files, activeTrack.id, targetTrackId)
  const suffix = result.skippedDuplicates > 0 ? ` (${result.skippedDuplicates} already present in target)` : ''
  vscode.window.setStatusBarMessage(`Moved ${result.transferredCount} file(s) to "${targetName}"${suffix}.`, 3000)
}

function resolveSelectedFiles(
  item: StackTreeItem | undefined,
  selectedItems: StackTreeItem[] | undefined,
  filesView: vscode.TreeView<StackTreeItem>,
): StagedFile[] {
  let raw: StackTreeItem[] = []
  if (selectedItems && selectedItems.length > 0) {
    raw = selectedItems
  } else if (item) {
    raw = [item]
  } else {
    raw = [...filesView.selection]
  }

  const unique = new Map<string, StagedFile>()
  for (const node of raw) {
    for (const file of getDescendantFiles(node)) {
      if (file.uri.scheme !== 'ai-stack') {
        unique.set(file.uri.toString(), file)
      }
    }
  }
  return Array.from(unique.values())
}

async function pickOrCreateTargetTrack(
  trackManager: TrackManager,
  activeTrackId: string,
  mode: 'copy' | 'move',
  fileCount: number,
): Promise<string | undefined> {
  const otherTracks = trackManager.allTracks.filter((t) => t.id !== activeTrackId)
  const actionLabel = mode === 'copy' ? 'Copy' : 'Move'

  const picks: TargetTrackPick[] = otherTracks.map((t) => ({
    label: `$(layers) ${t.name}`,
    description: `${t.files.length} ${t.files.length === 1 ? 'file' : 'files'}`,
    trackId: t.id,
  }))

  picks.push({
    label: '$(add) Create New Track...',
    description: `${actionLabel} ${fileCount} file(s) into a new track`,
    createNew: true,
  })

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `${actionLabel} ${fileCount} file(s) to which track?`,
    title: `${actionLabel} to Track`,
  })

  if (!chosen) {
    return undefined
  }

  if (chosen.createNew) {
    const newName = await vscode.window.showInputBox({
      prompt: 'Enter name for the new context track',
      placeHolder: 'e.g., "API Refactor"',
      validateInput: (value) => {
        const trimmed = value.trim()
        if (trimmed.length === 0) return 'Name cannot be empty'
        if (trackManager.isNameTaken(trimmed)) return 'Track name is already taken'
        return null
      },
    })

    if (!newName) {
      return undefined
    }

    return trackManager.createTrack(newName.trim(), false)
  }

  return chosen.trackId
}
