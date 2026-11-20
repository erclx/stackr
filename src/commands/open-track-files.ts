import * as vscode from 'vscode'

import { ContextTrack } from '../models'
import { TrackManager } from '../providers'
import { ErrorHandler, Logger } from '../utils'
import { Command, CommandDependencies } from './types'

const LARGE_TRACK_OPEN_THRESHOLD = 25

export function getOpenTrackFilesCommands(deps: CommandDependencies): Command[] {
  const { trackManager } = deps.services
  const { tracksView } = deps.views

  return [
    {
      id: 'aiContextStacker.openTrackFiles',
      execute: (item?: ContextTrack) => {
        return ErrorHandler.safeExecute('Open All Files in Track', () =>
          handleOpenTrackFiles(trackManager, tracksView, item),
        )()
      },
    },
  ]
}

async function handleOpenTrackFiles(
  trackManager: TrackManager,
  tracksView: vscode.TreeView<ContextTrack>,
  item?: ContextTrack,
): Promise<void> {
  const targetTrack =
    item ?? (tracksView.selection.length > 0 ? tracksView.selection[0] : trackManager.getActiveTrack())
  const files = targetTrack.files

  if (files.length === 0) {
    void vscode.window.showInformationMessage(`Track "${targetTrack.name}" has no files to open.`)
    return
  }

  if (files.length > LARGE_TRACK_OPEN_THRESHOLD) {
    const confirm = await vscode.window.showWarningMessage(
      `Track "${targetTrack.name}" contains ${files.length} files. Open all of them as editor tabs?`,
      { modal: true },
      'Open All',
    )
    if (confirm !== 'Open All') {
      return
    }
  }

  const targetUriKeys = new Set(files.map((f) => f.uri.toString()))
  const otherTabs = collectOtherCleanTabs(targetUriKeys)
  let closeOthers = false

  if (otherTabs.length > 0) {
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: '$(files) Open Alongside Current Tabs',
          description: `Keep ${otherTabs.length} existing tab(s) open`,
          closeOthers: false,
        },
        {
          label: '$(close-all) Close Other Tabs & Open Track Files',
          description: `Close ${otherTabs.length} clean tab(s) not in "${targetTrack.name}"`,
          closeOthers: true,
        },
      ],
      {
        placeHolder: `Open ${files.length} file(s) from "${targetTrack.name}"`,
        title: 'Open All Files in Track',
      },
    )

    if (!mode) {
      return
    }
    closeOthers = mode.closeOthers
  }

  if (targetTrack.id !== trackManager.getActiveTrack().id) {
    await trackManager.switchToTrack(targetTrack.id)
  }

  if (closeOthers && otherTabs.length > 0) {
    try {
      await vscode.window.tabGroups.close(otherTabs, true)
    } catch (error) {
      Logger.warn(`Failed to close some tabs before opening track files: ${(error as Error).message}`)
    }
  }

  let openedCount = 0
  let skippedCount = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    try {
      await vscode.window.showTextDocument(file.uri, {
        preview: false,
        preserveFocus: i > 0,
      })
      openedCount++
    } catch (error) {
      skippedCount++
      Logger.debug(`Skipped opening file ${file.uri.fsPath}: ${(error as Error).message}`)
    }
  }

  const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} could not be opened)` : ''
  vscode.window.setStatusBarMessage(`Opened ${openedCount} file(s) from "${targetTrack.name}"${skippedSuffix}.`, 3000)
}

function collectOtherCleanTabs(targetUriKeys: Set<string>): vscode.Tab[] {
  const tabsToClose: vscode.Tab[] = []

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.isDirty || tab.isPinned) {
        continue
      }

      if (tab.input instanceof vscode.TabInputText) {
        if (!targetUriKeys.has(tab.input.uri.toString())) {
          tabsToClose.push(tab)
        }
      }
    }
  }

  return tabsToClose
}
