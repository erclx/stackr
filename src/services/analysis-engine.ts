import * as vscode from 'vscode'

import { StagedFile } from '../models'
import { TrackManager } from '../providers'
import { Logger } from '../utils'
import { StatsProcessor } from './stats-processor'

export class AnalysisEngine implements vscode.Disposable {
  private _onDidUpdateStats = new vscode.EventEmitter<void>()
  public readonly onDidUpdateStats = this._onDidUpdateStats.event

  private _onDidStatusChange = new vscode.EventEmitter<void>()
  public readonly onDidStatusChange = this._onDidStatusChange.event

  private statsProcessor: StatsProcessor
  private _isWarmingUp = true
  private _activeEnrichmentCount = 0
  private _tokenEstimationEnabled = true
  private pendingUpdates = new Map<string, NodeJS.Timeout>()
  private disposables: vscode.Disposable[] = []

  private readonly HIGH_PRIORITY_DEBOUNCE_MS = 400
  private readonly LOW_PRIORITY_DEBOUNCE_MS = 2000
  private currentDebounceMs = this.HIGH_PRIORITY_DEBOUNCE_MS

  private lastUiUpdate = 0
  private readonly UI_THROTTLE_MS = 100

  constructor(
    private context: vscode.ExtensionContext,
    private trackManager: TrackManager,
  ) {
    this.statsProcessor = new StatsProcessor(context)
    this._tokenEstimationEnabled = this.readTokenEstimationSetting()
    if (!this._tokenEstimationEnabled) {
      this._isWarmingUp = false
    }
    this.registerListeners()
  }

  public get isWarmingUp(): boolean {
    return this._tokenEstimationEnabled && this._isWarmingUp
  }

  public get isAnalyzing(): boolean {
    return this._tokenEstimationEnabled && this._activeEnrichmentCount > 0
  }

  public get isTokenEstimationEnabled(): boolean {
    return this._tokenEstimationEnabled
  }

  public dispose(): void {
    this._onDidUpdateStats.dispose()
    this._onDidStatusChange.dispose()
    this.statsProcessor.dispose()
    this.disposables.forEach((d) => d.dispose())
    this.clearAllPendingTimers()
  }

  public setExecutionPriority(isHighPriority: boolean): void {
    this.currentDebounceMs = isHighPriority ? this.HIGH_PRIORITY_DEBOUNCE_MS : this.LOW_PRIORITY_DEBOUNCE_MS
  }

  public notifyFilesAdded(): void {
    this._onDidUpdateStats.fire()
  }

  public async enrichActiveTrack(token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) return

    if (!this._tokenEstimationEnabled) {
      this._isWarmingUp = false
      this._onDidStatusChange.fire()
      this._onDidUpdateStats.fire()
      return
    }

    this._activeEnrichmentCount++
    this._onDidStatusChange.fire()
    this._onDidUpdateStats.fire()

    try {
      const files = this.trackManager.getActiveTrack().files
      if (files.length === 0) {
        this._isWarmingUp = false
        this._onDidUpdateStats.fire()
        return
      }

      await this.statsProcessor.enrichFileStatsProgressive(
        files,
        () => {
          const now = Date.now()
          if (now - this.lastUiUpdate > this.UI_THROTTLE_MS) {
            this._onDidUpdateStats.fire()
            this.lastUiUpdate = now
          }
        },
        token,
      )
    } catch (error) {
      Logger.error('Stats enrichment failed', error as Error)
    } finally {
      this._activeEnrichmentCount = Math.max(0, this._activeEnrichmentCount - 1)

      if (this._isWarmingUp && this._activeEnrichmentCount === 0) {
        this._isWarmingUp = false
      }

      this._onDidStatusChange.fire()
      this._onDidUpdateStats.fire()
    }
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.handleDocChange(e.document)),

      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('aiContextStacker.enableTokenEstimation')) {
          this.handleTokenEstimationToggle()
        }
      }),

      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) {
          this.clearAllPendingTimers()
        }
      }),
    )
  }

  private readTokenEstimationSetting(): boolean {
    return vscode.workspace.getConfiguration('aiContextStacker').get<boolean>('enableTokenEstimation', true)
  }

  private handleTokenEstimationToggle(): void {
    const enabled = this.readTokenEstimationSetting()
    if (enabled === this._tokenEstimationEnabled) {
      return
    }

    this._tokenEstimationEnabled = enabled
    if (!enabled) {
      this.clearAllPendingTimers()
      this._isWarmingUp = false
      this._onDidStatusChange.fire()
      this._onDidUpdateStats.fire()
      Logger.info('Token estimation disabled.')
      return
    }

    Logger.info('Token estimation enabled. Enriching active track...')
    void this.enrichActiveTrack()
  }

  private handleDocChange(doc: vscode.TextDocument): void {
    if (!this._tokenEstimationEnabled) return

    const files = this.trackManager.getActiveTrack().files
    const target = files.find((f) => f.uri.toString() === doc.uri.toString())
    if (target) this.scheduleStatsUpdate(doc, target)
  }

  private scheduleStatsUpdate(doc: vscode.TextDocument, file: StagedFile): void {
    const key = doc.uri.toString()
    if (this.pendingUpdates.has(key)) clearTimeout(this.pendingUpdates.get(key)!)

    const timer = setTimeout(() => this.performStatsUpdate(doc, file), this.currentDebounceMs)
    this.pendingUpdates.set(key, timer)
  }

  private performStatsUpdate(doc: vscode.TextDocument, file: StagedFile): void {
    if (!this._tokenEstimationEnabled) {
      this.pendingUpdates.delete(doc.uri.toString())
      return
    }
    file.stats = this.statsProcessor.measure(doc.getText())
    this._onDidUpdateStats.fire()
    this.pendingUpdates.delete(doc.uri.toString())
  }

  private clearAllPendingTimers(): void {
    this.pendingUpdates.forEach(clearTimeout)
    this.pendingUpdates.clear()
  }
}
