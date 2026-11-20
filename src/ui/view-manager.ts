import * as vscode from 'vscode'

import { ContextTrack, StackTreeItem } from '../models'
import { IgnoreManager, StackProvider, TrackManager, TrackProvider } from '../providers'
import { AnalysisEngine } from '../services'
import { Logger } from '../utils'
import { StackDragDropController } from './stack-drag-drop'

export class ViewManager implements vscode.Disposable {
  public readonly filesView: vscode.TreeView<StackTreeItem>
  public readonly tracksView: vscode.TreeView<ContextTrack>

  private _disposables: vscode.Disposable[] = []
  private _lastAutoRevealedUri: string | undefined

  constructor(
    private stackProvider: StackProvider,
    trackListProvider: TrackProvider,
    private trackManager: TrackManager,
    ignoreProvider: IgnoreManager,
    private analysisEngine: AnalysisEngine,
  ) {
    const dragDropController = new StackDragDropController(stackProvider, ignoreProvider)

    this.filesView = vscode.window.createTreeView('aiContextStackerView', {
      treeDataProvider: stackProvider,
      dragAndDropController: dragDropController,
      canSelectMany: true,
    })

    this.tracksView = vscode.window.createTreeView('aiContextTracksView', {
      treeDataProvider: trackListProvider,
      dragAndDropController: trackListProvider,
      canSelectMany: false,
    })

    this.registerViewCommands()
    this.registerVisibilityHooks()
    this.registerAutoRevealHooks()

    this.updateTitle(trackManager.getActiveTrack().name, stackProvider)

    trackManager.onDidChangeTrack(
      (track) => {
        this._lastAutoRevealedUri = undefined
        this.updateTitle(track.name, stackProvider)
      },
      null,
      this._disposables,
    )

    stackProvider.onDidChangeTreeData(
      () => {
        this.updateTitle(trackManager.getActiveTrack().name, stackProvider)
        void this.tryAutoRevealActiveEditor(false)
      },
      null,
      this._disposables,
    )

    this._disposables.push(this.filesView, this.tracksView, dragDropController)
  }

  private registerViewCommands(): void {
    this._disposables.push(
      vscode.commands.registerCommand('aiContextStacker.collapseAll', () =>
        vscode.commands.executeCommand('workbench.actions.treeView.aiContextStackerView.collapseAll'),
      ),
    )
  }

  private registerVisibilityHooks(): void {
    this._disposables.push(
      this.filesView.onDidChangeVisibility((e) => {
        this.analysisEngine.setExecutionPriority(e.visible)
        if (e.visible) {
          void this.tryAutoRevealActiveEditor(true)
        }
      }),
    )
  }

  private registerAutoRevealHooks(): void {
    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor) {
          this._lastAutoRevealedUri = undefined
          return
        }
        void this.tryAutoRevealActiveEditor(true, editor.document.uri)
      }),
    )
  }

  private async tryAutoRevealActiveEditor(force: boolean, explicitUri?: vscode.Uri): Promise<void> {
    if (!this.filesView.visible) {
      return
    }

    const autoReveal = vscode.workspace.getConfiguration('aiContextStacker').get<boolean>('autoReveal', true)
    if (!autoReveal) {
      return
    }

    const targetUri = explicitUri ?? vscode.window.activeTextEditor?.document.uri
    if (!targetUri || targetUri.scheme !== 'file') {
      return
    }

    const targetKey = targetUri.toString()
    if (!force && this._lastAutoRevealedUri === targetKey) {
      return
    }

    const item = this.stackProvider.getStackItem(targetUri)
    if (!item) {
      return
    }

    try {
      this._lastAutoRevealedUri = targetKey
      await this.filesView.reveal(item, {
        select: true,
        focus: false,
        expand: true,
      })
    } catch (error) {
      this._lastAutoRevealedUri = undefined
      Logger.debug(`Auto-reveal skipped: ${(error as Error).message}`)
    }
  }

  private updateTitle(trackName: string, provider: StackProvider) {
    const baseTitle = `Staged Files — ${trackName}`

    if (provider.hasActiveFilters) {
      this.filesView.title = `${baseTitle} (Pinned Only)`
    } else {
      this.filesView.title = baseTitle
    }
  }

  public dispose() {
    this._disposables.forEach((d) => d.dispose())
  }
}
