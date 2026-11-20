import * as path from 'path'
import * as vscode from 'vscode'

import { StagedFile } from '../models'
import { StackProvider } from '../providers'
import { buildZipBuffer, ErrorHandler, Logger, normalizeZipEntryPath, ZipEntry } from '../utils'
import { Command, CommandDependencies } from './types'

export function getExportStackZipCommands(deps: CommandDependencies): Command[] {
  return [
    {
      id: 'aiContextStacker.exportStackZip',
      execute: ErrorHandler.safeExecute('Export Stack as Zip', async () => {
        await handleExportStackZip(deps.services.stackProvider)
      }),
    },
  ]
}

async function handleExportStackZip(provider: StackProvider): Promise<void> {
  const files = provider.getFiles()

  if (files.length === 0) {
    void vscode.window.showInformationMessage('Context stack is empty.')
    return
  }

  const trackName = provider.getActiveTrackName()
  const safeName = sanitizeFileName(trackName) || 'stackr-export'
  const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri
  const defaultUri = defaultDir
    ? vscode.Uri.joinPath(defaultDir, `${safeName}.zip`)
    : vscode.Uri.file(`${safeName}.zip`)

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { 'ZIP Archive': ['zip'] },
    saveLabel: 'Export Stack as Zip',
    title: `Export "${trackName}" as Zip`,
  })

  if (!saveUri) {
    return
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting "${trackName}" to Zip...`,
      cancellable: true,
    },
    async (_, token) => {
      const { entries, skipped } = await collectZipEntries(files, token)

      if (token.isCancellationRequested) {
        return
      }

      if (entries.length === 0) {
        void vscode.window.showWarningMessage('No readable files were found to export.')
        return
      }

      const zipBytes = buildZipBuffer(entries)
      await vscode.workspace.fs.writeFile(saveUri, zipBytes)

      const skippedSuffix = skipped > 0 ? ` (${skipped} skipped)` : ''
      void vscode.window.showInformationMessage(
        `Exported ${entries.length} file(s) with folder structure to ${path.basename(saveUri.fsPath)}${skippedSuffix}.`,
      )
    },
  )
}

async function collectZipEntries(
  files: StagedFile[],
  token: vscode.CancellationToken,
): Promise<{ entries: ZipEntry[]; skipped: number }> {
  const entries: ZipEntry[] = []
  let skipped = 0
  const isMultiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1

  for (const file of files) {
    if (token.isCancellationRequested) {
      break
    }

    try {
      const [data, stat] = await Promise.all([
        vscode.workspace.fs.readFile(file.uri),
        vscode.workspace.fs.stat(file.uri),
      ])

      const entryPath = resolveMirroredEntryPath(file.uri, isMultiRoot)
      entries.push({
        path: entryPath,
        data,
        mtime: stat.mtime ? new Date(stat.mtime) : undefined,
      })
    } catch (error) {
      skipped++
      Logger.warn(`Skipped unreadable file during zip export: ${file.uri.fsPath} (${(error as Error).message})`)
    }
  }

  return { entries, skipped }
}

export function resolveMirroredEntryPath(uri: vscode.Uri, isMultiRoot: boolean): string {
  const wsFolder = vscode.workspace.getWorkspaceFolder(uri)
  if (wsFolder) {
    const rel = path.relative(wsFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
    const full = isMultiRoot ? `${wsFolder.name}/${rel}` : rel
    const normalized = normalizeZipEntryPath(full)
    if (normalized) {
      return normalized
    }
  }

  const fallback = normalizeZipEntryPath(vscode.workspace.asRelativePath(uri, isMultiRoot))
  if (fallback && !path.isAbsolute(uri.fsPath ? fallback : '')) {
    return fallback
  }

  return `_external/${path.basename(uri.fsPath || uri.path) || 'file'}`
}

function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}
