import * as vscode from 'vscode'

import { StackProvider } from '../providers'
import { categorizeTargets, ErrorHandler } from '../utils'
import { Command, CommandDependencies } from './types'

export function getAddProblemFilesCommands(deps: CommandDependencies): Command[] {
  return [
    {
      id: 'aiContextStacker.addProblemFiles',
      execute: ErrorHandler.safeExecute('Add Files with Problems', async () => {
        await handleAddProblemFiles(deps.services.stackProvider)
      }),
    },
  ]
}

async function handleAddProblemFiles(provider: StackProvider): Promise<void> {
  const allDiagnostics = vscode.languages.getDiagnostics()

  const errorUris: vscode.Uri[] = []
  const errorOrWarningUris: vscode.Uri[] = []

  for (const [uri, diagnostics] of allDiagnostics) {
    if (uri.scheme !== 'file' || diagnostics.length === 0) {
      continue
    }

    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      continue
    }

    let hasError = false
    let hasWarning = false

    for (const diag of diagnostics) {
      if (diag.severity === vscode.DiagnosticSeverity.Error) {
        hasError = true
      } else if (diag.severity === vscode.DiagnosticSeverity.Warning) {
        hasWarning = true
      }
    }

    if (hasError) {
      errorUris.push(uri)
      errorOrWarningUris.push(uri)
    } else if (hasWarning) {
      errorOrWarningUris.push(uri)
    }
  }

  if (errorOrWarningUris.length === 0) {
    void vscode.window.showInformationMessage('No workspace files with errors or warnings found.')
    return
  }

  let selectedUris = errorOrWarningUris

  if (errorUris.length > 0 && errorOrWarningUris.length > errorUris.length) {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(error) Errors Only',
          description: `${errorUris.length} ${errorUris.length === 1 ? 'file' : 'files'}`,
          uris: errorUris,
        },
        {
          label: '$(warning) Errors & Warnings',
          description: `${errorOrWarningUris.length} ${errorOrWarningUris.length === 1 ? 'file' : 'files'}`,
          uris: errorOrWarningUris,
        },
      ],
      {
        placeHolder: 'Select which problem files to add to Stackr',
        title: 'Add Files with Problems',
      },
    )

    if (!choice) {
      return
    }
    selectedUris = choice.uris
  }

  const { files } = await categorizeTargets(selectedUris)
  if (files.length === 0) {
    void vscode.window.showInformationMessage('No readable problem files found.')
    return
  }

  const added = await provider.addFiles(files)
  if (added) {
    vscode.window.setStatusBarMessage(`Added ${files.length} file(s) with problems to Stackr.`, 3000)
  } else {
    void vscode.window.showInformationMessage('All files with problems are already in the current stack.')
  }
}
