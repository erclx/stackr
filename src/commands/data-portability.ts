import * as path from 'path'
import { TextDecoder, TextEncoder } from 'util'
import * as vscode from 'vscode'

import { StackrExportData } from '../models'
import { TrackManager } from '../providers'
import { ErrorHandler } from '../utils'
import { Command, CommandDependencies } from './types'

export function getDataPortabilityCommands(deps: CommandDependencies): Command[] {
  const { trackManager } = deps.services

  return [
    {
      id: 'aiContextStacker.exportData',
      execute: ErrorHandler.safeExecute('Export Stackr Data', async () => {
        await handleExportData(trackManager)
      }),
    },
    {
      id: 'aiContextStacker.importData',
      execute: ErrorHandler.safeExecute('Import Stackr Data', async () => {
        await handleImportData(trackManager)
      }),
    },
  ]
}

async function handleExportData(trackManager: TrackManager): Promise<void> {
  const allTracks = trackManager.allTracks
  let scope: 'all' | 'active' = 'all'

  if (allTracks.length > 1) {
    const activeTrack = trackManager.getActiveTrack()
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(layers) All Tracks',
          description: `${allTracks.length} tracks`,
          scope: 'all' as const,
        },
        {
          label: `$(check) Current Track Only (${activeTrack.name})`,
          description: `${activeTrack.files.length} files`,
          scope: 'active' as const,
        },
      ],
      {
        placeHolder: 'Select what to export for transfer to another device',
        title: 'Export Stackr Data',
      },
    )

    if (!choice) {
      return
    }
    scope = choice.scope
  }

  const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
  const defaultUri = defaultDir
    ? vscode.Uri.joinPath(defaultDir, 'stackr-data.json')
    : vscode.Uri.file('stackr-data.json')

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'Stackr Data (JSON)': ['json'] },
    saveLabel: 'Export Data',
    title: 'Export Stackr Data',
  })

  if (!saveUri) {
    return
  }

  const exportData = trackManager.exportTracksData(scope)
  const json = JSON.stringify(exportData, null, 2) + '\n'
  const encoder = new TextEncoder()
  await vscode.workspace.fs.writeFile(saveUri, encoder.encode(json))

  const totalFiles = exportData.tracks.reduce((sum, t) => sum + t.files.length, 0)
  void vscode.window.showInformationMessage(
    `Exported ${exportData.tracks.length} track(s) (${totalFiles} file reference(s)) to ${path.basename(saveUri.fsPath)}.`,
  )
}

async function handleImportData(trackManager: TrackManager): Promise<void> {
  const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
  const selected = await vscode.window.showOpenDialog({
    defaultUri: defaultDir,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'Stackr Data (JSON)': ['json'] },
    openLabel: 'Import Data',
    title: 'Import Stackr Data',
  })

  if (!selected || selected.length === 0) {
    return
  }

  const rawBytes = await vscode.workspace.fs.readFile(selected[0])
  const decoder = new TextDecoder('utf-8')
  let parsed: StackrExportData

  try {
    parsed = JSON.parse(decoder.decode(rawBytes)) as StackrExportData
  } catch {
    void vscode.window.showErrorMessage('Invalid JSON file. Please select a valid Stackr export file.')
    return
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tracks)) {
    void vscode.window.showErrorMessage('Unrecognized Stackr export file format.')
    return
  }

  const modePick = await vscode.window.showQuickPick(
    [
      {
        label: '$(git-merge) Merge with Existing Tracks',
        description: 'Keep existing tracks and add or merge imported tracks',
        mode: 'merge' as const,
      },
      {
        label: '$(replace-all) Replace All Tracks',
        description: 'Overwrite current workspace tracks with the imported data',
        mode: 'replace' as const,
      },
    ],
    {
      placeHolder: `Import ${parsed.tracks.length} track(s) — choose import mode`,
      title: 'Import Stackr Data',
    },
  )

  if (!modePick) {
    return
  }

  const result = await trackManager.importTracksData(parsed, modePick.mode)
  const missingNote =
    result.missingFiles > 0 ? ` (${result.missingFiles} file(s) not found in this workspace were skipped)` : ''

  void vscode.window.showInformationMessage(
    `Imported ${result.importedTracks} track(s) with ${result.importedFiles} file(s)${missingNote}.`,
  )
}
