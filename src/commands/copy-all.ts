import * as vscode from 'vscode'

import { StagedFile } from '../models'
import { StackProvider } from '../providers'
import { ClipboardOps, ContentFormatter, ErrorHandler, FormatOptions } from '../utils'
import { Command, CommandDependencies } from './types'

export function getCopyAllCommands(deps: CommandDependencies): Command[] {
  return [
    {
      id: 'aiContextStacker.copyAll',
      execute: ErrorHandler.safeExecute('Copy All Files', async () => {
        await handleCopyAll(deps.services.stackProvider)
      }),
    },
    {
      id: 'aiContextStacker.copyContextMap',
      execute: ErrorHandler.safeExecute('Copy Context Map', async () => {
        await handleCopyContextMap(deps.services.stackProvider)
      }),
    },
  ]
}

async function handleCopyAll(provider: StackProvider): Promise<void> {
  const files = provider.getFiles() as StagedFile[]

  if (files.length === 0) {
    void vscode.window.showInformationMessage('Context stack is empty.')
    return
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Building AI Context...',
      cancellable: true,
    },
    async (_, token) => {
      const result = await generateContext(files, token)

      if (result !== undefined) {
        await ClipboardOps.copyText(result, `${files.length} files`, () => {
          void vscode.commands.executeCommand('aiContextStacker.statusBar.showSuccess')
        })
      }
    },
  )
}

async function handleCopyContextMap(provider: StackProvider): Promise<void> {
  const files = provider.getFiles() as StagedFile[]

  if (files.length === 0) {
    void vscode.window.showInformationMessage('Context stack is empty.')
    return
  }

  const cts = new vscode.CancellationTokenSource()
  try {
    const result = await generateContext(files, cts.token, {
      forceTree: true,
      skipContents: true,
    })

    if (result !== undefined) {
      await ClipboardOps.copyText(result.trimEnd() + '\n', `Context Map (${files.length} files)`, () => {
        void vscode.commands.executeCommand('aiContextStacker.statusBar.showSuccess')
      })
    }
  } finally {
    cts.dispose()
  }
}

export async function generateContext(
  files: StagedFile[],
  token: vscode.CancellationToken,
  extraOpts: Omit<FormatOptions, 'token'> = {},
): Promise<string | undefined> {
  let finalOutput = ''

  for await (const chunk of ContentFormatter.formatStream(files, { ...extraOpts, token })) {
    if (token.isCancellationRequested) return undefined
    finalOutput += chunk
  }

  return token.isCancellationRequested ? undefined : finalOutput
}
