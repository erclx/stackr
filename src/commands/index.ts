import * as vscode from 'vscode'

import { getAddCurrentFileCommands } from './add-current-file'
import { getAddFileContextMenuCommands } from './add-file-context-menu'
import { getAddFilePickerCommands } from './add-file-picker'
import { getAddFolderPickerCommands } from './add-folder-picker'
import { getAddGitFilesCommands } from './add-git-files'
import { getAddOpenFilesCommands } from './add-open-files'
import { getAddProblemFilesCommands } from './add-problem-files'
import { getClearAllCommands } from './clear-all'
import { getCopyAllCommands } from './copy-all'
import { getCopyAndClearCommands } from './copy-and-clear'
import { getCopyFileCommands } from './copy-file'
import { getDataPortabilityCommands } from './data-portability'
import { getExportStackZipCommands } from './export-stack-zip'
import { getFilterCommands } from './filter-commands'
import { getOpenTrackFilesCommands } from './open-track-files'
import { getPreviewContextCommands } from './preview-context'
import { getRefreshStackCommands } from './refresh-stack'
import { getRemoveFileCommands } from './remove-file'
import { getRemoveFilePickerCommands } from './remove-file-picker'
import { getRemoveFolderPickerCommands } from './remove-folder-picker'
import { getRevealInExplorerCommands } from './reveal-in-explorer'
import { getRevealInViewCommands } from './reveal-in-view'
import { getSelectAllCommands } from './select-all'
import { getOpenSettingsCommands } from './settings'
import { getTogglePinCommands } from './toggle-pin'
import { getTrackCommands } from './track-ops'
import { getTransferFilesCommands } from './transfer-files'
import { Command, CommandDependencies } from './types'
import { getUnpinAllCommands } from './unpin-all'

export { CommandDependencies } from './types'

export function registerAllCommands(deps: CommandDependencies): void {
  const factories = [
    getAddCurrentFileCommands,
    getAddFileContextMenuCommands,
    getAddFilePickerCommands,
    getAddFolderPickerCommands,
    getAddGitFilesCommands,
    getAddOpenFilesCommands,
    getAddProblemFilesCommands,
    getRemoveFileCommands,
    getRemoveFilePickerCommands,
    getRemoveFolderPickerCommands,
    getTogglePinCommands,
    getUnpinAllCommands,
    getClearAllCommands,
    getSelectAllCommands,
    getRefreshStackCommands,

    getCopyAllCommands,
    getCopyAndClearCommands,
    getCopyFileCommands,
    getExportStackZipCommands,

    getTrackCommands,
    getOpenTrackFilesCommands,
    getTransferFilesCommands,
    getDataPortabilityCommands,

    getPreviewContextCommands,
    getOpenSettingsCommands,
    getFilterCommands,
    getRevealInViewCommands,
    getRevealInExplorerCommands,
  ]

  const allCommands = factories.flatMap((factory) => factory(deps))

  allCommands.forEach((cmd) => {
    register(deps.context, cmd)
  })
}

function register(context: vscode.ExtensionContext, cmd: Command): void {
  context.subscriptions.push(vscode.commands.registerCommand(cmd.id, cmd.execute))
}
