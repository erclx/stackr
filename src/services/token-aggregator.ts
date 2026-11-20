import * as vscode from 'vscode'

import { StagedFile } from '../models'
import { TrackManager } from '../providers'
import { AnalysisEngine } from './analysis-engine'

export class TokenAggregatorService implements vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<number>()
  public readonly onDidChange = this._onDidChange.event

  private _totalTokens = 0
  private _lastEnabled: boolean
  private _disposables: vscode.Disposable[] = []

  constructor(
    private trackManager: TrackManager,
    private analysisEngine: AnalysisEngine,
  ) {
    this._lastEnabled = analysisEngine.isTokenEstimationEnabled
    this.registerListeners()
    this.recalculate()
  }

  public get totalTokens(): number {
    return this.analysisEngine.isTokenEstimationEnabled ? this._totalTokens : 0
  }

  public get isTokenEstimationEnabled(): boolean {
    return this.analysisEngine.isTokenEstimationEnabled
  }

  public format(count: number): string {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}k`
    }
    return count.toString()
  }

  public dispose(): void {
    this._disposables.forEach((d) => d.dispose())
    this._onDidChange.dispose()
  }

  private registerListeners(): void {
    this._disposables.push(this.trackManager.onDidChangeTrack(() => this.recalculate()))

    this._disposables.push(this.analysisEngine.onDidUpdateStats(() => this.recalculate()))
    this._disposables.push(this.analysisEngine.onDidStatusChange(() => this.recalculate()))
  }

  private recalculate(): void {
    const enabled = this.analysisEngine.isTokenEstimationEnabled
    if (!enabled) {
      const changed = this._totalTokens !== 0 || this._lastEnabled !== enabled
      this._totalTokens = 0
      this._lastEnabled = false
      if (changed) {
        this._onDidChange.fire(0)
      }
      return
    }

    const enabledChanged = !this._lastEnabled
    this._lastEnabled = true

    const activeTrack = this.trackManager.getActiveTrack()

    if (activeTrack.id === 'ghost') {
      if (this._totalTokens !== 0 || enabledChanged) {
        this._totalTokens = 0
        this._onDidChange.fire(0)
      }
      return
    }

    const files = activeTrack.files
    const newTotal = this.sumTokens(files)

    if (newTotal !== this._totalTokens || enabledChanged) {
      this._totalTokens = newTotal
      this._onDidChange.fire(this._totalTokens)
    }
  }

  private sumTokens(files: StagedFile[]): number {
    return files.reduce((sum, file) => sum + (file.stats?.tokenCount ?? 0), 0)
  }
}
