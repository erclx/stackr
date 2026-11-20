import * as path from 'path'
import * as vscode from 'vscode'

import {
  ContextTrack,
  ExportedStackFile,
  ExportedTrack,
  refreshFileLabel,
  StackrExportData,
  StagedFile,
} from '../models'
import { HydrationService, PersistenceService, StateMapper } from '../services'
import { generateId, Logger } from '../utils'
import { isChildOf } from '../utils/file-scanner'

export interface TransferResult {
  transferredCount: number
  skippedDuplicates: number
}

export interface ImportResult {
  importedTracks: number
  importedFiles: number
  missingFiles: number
}

export class TrackManager implements vscode.Disposable {
  private tracks = new Map<string, ContextTrack>()
  private activeTrackId = 'default'
  private _trackOrder: string[] = ['default']

  private _isInitialized = false
  private _isDisposed = false
  private _hydrationTimer: NodeJS.Timeout | undefined

  private _onDidChangeTrack = new vscode.EventEmitter<ContextTrack>()
  readonly onDidChangeTrack = this._onDidChangeTrack.event

  constructor(
    private context: vscode.ExtensionContext,
    private persistence: PersistenceService,
    private hydrationService: HydrationService,
  ) {
    this.createDefaultTrack(false)
    this.scheduleAsyncHydration()
  }

  public get isInitialized(): boolean {
    return this._isInitialized
  }

  public get allTracks(): ContextTrack[] {
    return this._trackOrder.map((id) => this.tracks.get(id)).filter((t): t is ContextTrack => t !== undefined)
  }

  public getTrackById(id: string): ContextTrack | undefined {
    return this.tracks.get(id)
  }

  public async flushSaveNow(): Promise<void> {
    if (this._isDisposed || !this._isInitialized) {
      return
    }
    await this.persistence.saveImmediate(this.tracks, this.activeTrackId, this._trackOrder, true)
  }

  public getActiveTrack(): ContextTrack {
    const track = this.tracks.get(this.activeTrackId)
    if (!track) {
      return this.createDefaultTrack(true)
    }
    return track
  }

  public dispose(): void {
    if (this._isDisposed) return
    this._isDisposed = true

    if (this._hydrationTimer) {
      clearTimeout(this._hydrationTimer)
      this._hydrationTimer = undefined
    }

    this._onDidChangeTrack.dispose()
    Logger.debug('TrackManager disposed.')
  }

  public async switchToTrack(id: string): Promise<void> {
    if (this._isDisposed || !this.tracks.has(id)) return
    this.activeTrackId = id
    await this.persistence.saveImmediate(this.tracks, this.activeTrackId, this._trackOrder)
    this.updateContextKeys()
    this.fireChange()
  }

  public createTrack(baseName: string, switchImmediately: boolean = true): string {
    const id = generateId('track')
    const uniqueName = this.ensureUniqueName(baseName)

    this.tracks.set(id, { id, name: uniqueName, files: [] })
    this._trackOrder.push(id)

    if (switchImmediately) {
      void this.switchToTrack(id)
    } else {
      this.requestSave()
      this.updateContextKeys()
      this.fireChange()
    }
    return id
  }

  public renameTrack(id: string, newName: string): boolean {
    const track = this.tracks.get(id)
    if (!track) return false

    if (track.name === newName) return true

    if (this.isNameTaken(newName)) {
      return false
    }

    track.name = newName
    this.requestSave()
    this.updateContextKeys()
    this.fireChange(track)
    return true
  }

  public deleteTrack(id: string): void {
    if (this.tracks.size <= 1) return

    this.tracks.delete(id)
    this._trackOrder = this._trackOrder.filter((tid) => tid !== id)
    this.handleTrackDeletion(id)
  }

  public deleteAllTracks(): void {
    void this.hardReset()
  }

  public async hardReset(): Promise<void> {
    Logger.warn('Hard Reset initiated.')
    this.tracks.clear()
    this._trackOrder = []

    if (!this._isDisposed) {
      await this.persistence.clear()
    }

    this.createDefaultTrack(true)
    await this.persistence.saveImmediate(this.tracks, this.activeTrackId, this._trackOrder)
    this.updateContextKeys()
    this.fireChange()
  }

  public moveTrackRelative(id: string, direction: 'up' | 'down'): void {
    const index = this._trackOrder.indexOf(id)
    if (index === -1) return

    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= this._trackOrder.length) return

    this.swapTracks(index, newIndex)
  }

  public reorderTracks(sourceId: string, targetId: string | undefined): void {
    const fromIndex = this._trackOrder.indexOf(sourceId)
    if (fromIndex === -1) return

    this._trackOrder.splice(fromIndex, 1)
    this.insertTrackAtTarget(sourceId, targetId)

    this.requestSave()
    this.fireChange()
  }

  public copyFilesToTrack(files: StagedFile[], targetTrackId: string): TransferResult {
    const targetTrack = this.tracks.get(targetTrackId)
    if (!targetTrack || files.length === 0) {
      return { transferredCount: 0, skippedDuplicates: 0 }
    }

    const existing = new Set(targetTrack.files.map((f) => f.uri.toString()))
    const toAdd: StagedFile[] = []
    let skippedDuplicates = 0

    for (const file of files) {
      const key = file.uri.toString()
      if (existing.has(key)) {
        skippedDuplicates++
        continue
      }
      existing.add(key)
      toAdd.push({
        type: 'file',
        uri: file.uri,
        label: file.label,
        stats: file.stats ? { ...file.stats } : undefined,
        isBinary: file.isBinary,
        isPinned: !!file.isPinned,
        isFromFolderAddition: !!file.isFromFolderAddition,
      })
    }

    if (toAdd.length > 0) {
      targetTrack.files.push(...toAdd)
      this.finalizeChange()
    }

    return { transferredCount: toAdd.length, skippedDuplicates }
  }

  public moveFilesToTrack(files: StagedFile[], sourceTrackId: string, targetTrackId: string): TransferResult {
    if (sourceTrackId === targetTrackId || files.length === 0) {
      return { transferredCount: 0, skippedDuplicates: 0 }
    }

    const sourceTrack = this.tracks.get(sourceTrackId)
    const targetTrack = this.tracks.get(targetTrackId)
    if (!sourceTrack || !targetTrack) {
      return { transferredCount: 0, skippedDuplicates: 0 }
    }

    const existingInTarget = new Set(targetTrack.files.map((f) => f.uri.toString()))
    const toRemoveKeys = new Set(files.map((f) => f.uri.toString()))
    const toAdd: StagedFile[] = []
    let skippedDuplicates = 0

    for (const file of files) {
      const key = file.uri.toString()
      if (existingInTarget.has(key)) {
        skippedDuplicates++
        continue
      }
      existingInTarget.add(key)
      toAdd.push({
        type: 'file',
        uri: file.uri,
        label: file.label,
        stats: file.stats ? { ...file.stats } : undefined,
        isBinary: file.isBinary,
        isPinned: !!file.isPinned,
        isFromFolderAddition: !!file.isFromFolderAddition,
      })
    }

    sourceTrack.files = sourceTrack.files.filter((f) => !toRemoveKeys.has(f.uri.toString()))
    if (toAdd.length > 0) {
      targetTrack.files.push(...toAdd)
    }

    this.finalizeChange()
    return { transferredCount: toAdd.length, skippedDuplicates }
  }

  public exportTracksData(scope: 'all' | 'active' = 'all'): StackrExportData {
    const selectedTracks = scope === 'active' ? [this.getActiveTrack()] : this.allTracks
    const exportedTracks: ExportedTrack[] = selectedTracks.map((track) => ({
      id: track.id,
      name: track.name,
      files: track.files.map((file) => this.serializePortableFile(file)),
    }))

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      activeTrackId: scope === 'active' ? selectedTracks[0].id : this.activeTrackId,
      trackOrder: exportedTracks.map((t) => t.id),
      tracks: exportedTracks,
    }
  }

  public async importTracksData(data: StackrExportData, mode: 'merge' | 'replace'): Promise<ImportResult> {
    if (!data || !Array.isArray(data.tracks)) {
      throw new Error('Invalid Stackr export format: missing tracks array.')
    }

    let importedTracks = 0
    let importedFiles = 0
    let missingFiles = 0

    const resolvedTracks: ContextTrack[] = []

    for (const rawTrack of data.tracks) {
      if (!rawTrack || typeof rawTrack.name !== 'string') {
        continue
      }

      const trackFiles: StagedFile[] = []
      const seenUris = new Set<string>()
      const rawFiles = Array.isArray(rawTrack.files) ? rawTrack.files : []

      for (const rawFile of rawFiles) {
        if (!rawFile || typeof rawFile.path !== 'string') {
          continue
        }
        const resolvedUri = await this.resolvePortableFileUri(rawFile)
        if (!resolvedUri) {
          missingFiles++
          continue
        }

        const key = resolvedUri.toString()
        if (seenUris.has(key)) {
          continue
        }
        seenUris.add(key)

        trackFiles.push({
          type: 'file',
          uri: resolvedUri,
          label: StateMapper.extractLabel(resolvedUri),
          isPinned: !!rawFile.isPinned,
          isFromFolderAddition: !!rawFile.isFromFolderAddition,
        })
        importedFiles++
      }

      resolvedTracks.push({
        id: typeof rawTrack.id === 'string' && rawTrack.id.trim() ? rawTrack.id : generateId('track'),
        name: rawTrack.name.trim() || 'Imported Track',
        files: trackFiles,
      })
      importedTracks++
    }

    if (mode === 'replace') {
      this.tracks.clear()
      this._trackOrder = []

      if (resolvedTracks.length === 0) {
        this.createDefaultTrack(true)
      } else {
        for (const track of resolvedTracks) {
          const uniqueId = this.tracks.has(track.id) ? generateId('track') : track.id
          const uniqueName = this.ensureUniqueName(track.name)
          this.tracks.set(uniqueId, { id: uniqueId, name: uniqueName, files: track.files })
          this._trackOrder.push(uniqueId)
        }

        const requestedActive = data.activeTrackId
        this.activeTrackId = this.tracks.has(requestedActive) ? requestedActive : this._trackOrder[0]
      }
    } else {
      for (const track of resolvedTracks) {
        const existingByName = Array.from(this.tracks.values()).find((t) => t.name === track.name)
        if (existingByName) {
          const existingSet = new Set(existingByName.files.map((f) => f.uri.toString()))
          for (const file of track.files) {
            if (!existingSet.has(file.uri.toString())) {
              existingByName.files.push(file)
              existingSet.add(file.uri.toString())
            }
          }
        } else {
          const newId = this.tracks.has(track.id) ? generateId('track') : track.id
          const uniqueName = this.ensureUniqueName(track.name)
          this.tracks.set(newId, { id: newId, name: uniqueName, files: track.files })
          this._trackOrder.push(newId)
        }
      }
    }

    this.validateStateIntegrity()
    await this.persistence.saveImmediate(this.tracks, this.activeTrackId, this._trackOrder)
    this.updateContextKeys()
    this.fireChange()

    return { importedTracks, importedFiles, missingFiles }
  }

  public toggleFilesPin(files: StagedFile[]): void {
    if (!files?.length) return
    files.forEach((f) => (f.isPinned = !f.isPinned))
    this.requestSave()
    this.fireChange()
  }

  public unpinAllInActive(): void {
    const track = this.getActiveTrack()
    track.files.forEach((f) => (f.isPinned = false))
    this.requestSave()
    this.fireChange(track)
  }

  public hasUri(uri: vscode.Uri): boolean {
    const uriStr = uri.toString()
    for (const track of this.tracks.values()) {
      if (track.files.some((f) => f.uri.toString() === uriStr)) {
        return true
      }
    }
    return false
  }

  public async processBatchDeletions(uris: vscode.Uri[]): Promise<void> {
    if (this._isDisposed || uris.length === 0) return

    const deletedSet = new Set(uris.map((u) => u.toString()))
    let changed = false

    let lastYield = Date.now()
    const YIELD_MS = 16

    for (const track of this.tracks.values()) {
      if (track.files.length === 0) continue

      const toRemoveIds = new Set<string>()

      for (const file of track.files) {
        if (Date.now() - lastYield > YIELD_MS) {
          await new Promise((resolve) => setImmediate(resolve))
          if (this._isDisposed) return
          lastYield = Date.now()
        }

        let shouldRemove = deletedSet.has(file.uri.toString())

        if (!shouldRemove) {
          for (const deletedUri of uris) {
            if (isChildOf(deletedUri, file.uri)) {
              shouldRemove = true
              break
            }
          }
        }

        if (shouldRemove) {
          toRemoveIds.add(file.uri.toString())
        }
      }

      if (toRemoveIds.size > 0) {
        track.files = track.files.filter((f) => !toRemoveIds.has(f.uri.toString()))
        changed = true
      }
    }

    if (changed) {
      this.finalizeChange()
      Logger.info(`Processed batch deletion of ${uris.length} roots.`)
    }
  }

  public removeUriEverywhere(uri: vscode.Uri): void {
    const uriStr = uri.toString()
    let changed = false

    for (const track of this.tracks.values()) {
      const prevLen = track.files.length
      track.files = track.files.filter((f) => f.uri.toString() !== uriStr)
      if (track.files.length !== prevLen) {
        changed = true
      }
    }

    if (changed) this.finalizeChange()
  }

  public replaceUri(oldUri: vscode.Uri, newUri: vscode.Uri): void {
    const oldStr = oldUri.toString()
    const oldFsPath = this.normalizePath(oldUri.fsPath)
    let changed = false

    for (const track of this.tracks.values()) {
      const file = track.files.find((f) => {
        if (f.uri.toString() === oldStr) return true
        return this.normalizePath(f.uri.fsPath) === oldFsPath
      })

      if (file) {
        this.updateFileUri(file, newUri)
        this.checkAndResetFolderFlag(file)
        changed = true
      }
    }

    if (changed) this.finalizeChange()
  }

  public async replaceUriPrefix(oldRoot: vscode.Uri, newRoot: vscode.Uri): Promise<void> {
    let changed = false
    let lastYield = Date.now()
    const YIELD_MS = 20

    for (const track of this.tracks.values()) {
      if (track.files.length === 0) continue

      for (const file of track.files) {
        if (Date.now() - lastYield > YIELD_MS) {
          await new Promise((resolve) => setImmediate(resolve))
          if (this._isDisposed) return
          lastYield = Date.now()
        }

        if (isChildOf(oldRoot, file.uri)) {
          const relativePath = path.relative(oldRoot.fsPath, file.uri.fsPath)

          if (relativePath && !relativePath.startsWith('..')) {
            const newUri = vscode.Uri.file(path.join(newRoot.fsPath, relativePath))
            this.updateFileUri(file, newUri)
            this.checkAndResetFolderFlag(file)
            changed = true
          }
        } else {
          const rel = path.relative(this.normalizePath(oldRoot.fsPath), this.normalizePath(file.uri.fsPath))
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
            const newUri = vscode.Uri.file(path.join(newRoot.fsPath, rel))
            this.updateFileUri(file, newUri)
            this.checkAndResetFolderFlag(file)
            changed = true
          }
        }
      }
    }

    if (changed) {
      this.finalizeChange()
      Logger.info(`Processed folder rename: ${oldRoot.fsPath} -> ${newRoot.fsPath}`)
    }
  }

  private serializePortableFile(file: StagedFile): ExportedStackFile {
    const wsFolder = vscode.workspace.getWorkspaceFolder(file.uri)
    if (wsFolder) {
      const rel = path.relative(wsFolder.uri.fsPath, file.uri.fsPath).replace(/\\/g, '/')
      return {
        path: rel,
        workspaceFolder: wsFolder.name,
        isPinned: !!file.isPinned,
        isFromFolderAddition: !!file.isFromFolderAddition,
      }
    }

    const fallbackRelative = vscode.workspace.asRelativePath(file.uri, false).replace(/\\/g, '/')
    const storedPath =
      fallbackRelative === file.uri.fsPath || fallbackRelative === file.uri.path
        ? file.uri.toString()
        : fallbackRelative

    return {
      path: storedPath,
      isPinned: !!file.isPinned,
      isFromFolderAddition: !!file.isFromFolderAddition,
    }
  }

  private async resolvePortableFileUri(file: ExportedStackFile): Promise<vscode.Uri | null> {
    const normalized = file.path.replace(/\\/g, '/')
    const folders = vscode.workspace.workspaceFolders || []

    if (!normalized.includes('://') && !normalized.startsWith('/') && !/^[a-zA-Z]:\//.test(normalized)) {
      const orderedFolders = [...folders]
      if (file.workspaceFolder) {
        orderedFolders.sort((a, b) => {
          const aMatch = a.name === file.workspaceFolder ? 0 : 1
          const bMatch = b.name === file.workspaceFolder ? 0 : 1
          return aMatch - bMatch
        })
      }

      const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.')
      for (const folder of orderedFolders) {
        const candidate = vscode.Uri.joinPath(folder.uri, ...segments)
        try {
          await vscode.workspace.fs.stat(candidate)
          return candidate
        } catch {
          // Try next workspace folder
        }
      }
    }

    return StateMapper.resolveValidUri(file.path)
  }

  private normalizePath(p: string): string {
    let res = p
    res = res.replace(/\\/g, '/')

    if (process.platform === 'darwin' || process.platform === 'win32') {
      res = res.toLowerCase()
    }
    return res
  }

  private checkAndResetFolderFlag(file: StagedFile): void {
    if (!file.isFromFolderAddition) return

    const wsFolder = vscode.workspace.getWorkspaceFolder(file.uri)
    if (!wsFolder) return

    const fileDir = this.normalizePath(path.dirname(file.uri.fsPath))
    const rootDir = this.normalizePath(wsFolder.uri.fsPath)

    if (fileDir === rootDir) {
      file.isFromFolderAddition = false
    }
  }

  public addFilesToActive(uris: vscode.Uri[], fromFolder: boolean = false): StagedFile[] {
    const track = this.ensureActiveTrack()
    const newFiles = this.filterNewFiles(track, uris, fromFolder)

    if (newFiles.length > 0) {
      track.files.push(...newFiles)
      this.finalizeChange()
    }
    return newFiles
  }

  public removeFilesFromActive(files: StagedFile[]): void {
    const track = this.getActiveTrack()
    const targets = new Set(files.map((f) => f.uri.toString()))
    track.files = track.files.filter((f) => !targets.has(f.uri.toString()))
    this.finalizeChange()
  }

  public clearActive(): void {
    const track = this.getActiveTrack()
    track.files = track.files.filter((f) => f.isPinned)
    this.finalizeChange()
  }

  public isNameTaken(name: string): boolean {
    for (const track of this.tracks.values()) {
      if (track.name === name) return true
    }
    return false
  }

  private ensureUniqueName(baseName: string): string {
    if (!this.isNameTaken(baseName)) return baseName

    let counter = 2
    while (true) {
      const candidate = `${baseName} (${counter})`
      if (!this.isNameTaken(candidate)) return candidate
      counter++
    }
  }

  private requestSave(): void {
    this.persistence.requestSave(this.tracks, this.activeTrackId, this._trackOrder)
  }

  private scheduleAsyncHydration(): void {
    this._hydrationTimer = setTimeout(() => {
      if (this._isDisposed) return
      void this.performHydration()
      this._hydrationTimer = undefined
    }, 10)
  }

  private async performHydration(): Promise<void> {
    if (this._isDisposed) return

    try {
      const result = await this.hydrationService.hydrate()

      if (this._isDisposed) return

      if (result) {
        this.tracks = result.tracks
        this.activeTrackId = result.activeTrackId
        this._trackOrder = result.trackOrder
      } else {
        Logger.info('No previous state found, using default track')
        if (this.tracks.size === 0) this.createDefaultTrack(true)
      }

      this.validateStateIntegrity()
      this._isInitialized = true
      this.updateContextKeys()
      this.fireChange()
    } catch (error) {
      Logger.error('Hydration failed catastrophically', error as Error)
      this.createDefaultTrack(true)
      this._isInitialized = true
      this.fireChange()
    }
  }

  private fireChange(track?: ContextTrack): void {
    if (!this._isDisposed) {
      this._onDidChangeTrack.fire(track || this.getActiveTrack())
    }
  }

  private finalizeChange(): void {
    this.requestSave()
    this.updateContextKeys()
    this.fireChange()
  }

  private updateContextKeys(): void {
    if (this._isDisposed) return
    const hasTracks = this.tracks.size > 0
    void vscode.commands.executeCommand('setContext', 'aiContextStacker.hasTracks', hasTracks)
    void vscode.commands.executeCommand('setContext', 'aiContextStacker.canReset', this.calculateCanReset())
  }

  private calculateCanReset(): boolean {
    if (this.tracks.size > 1) return true
    const track = this.tracks.values().next().value
    if (!track) return false
    return track.files.length > 0 || track.name !== 'Main'
  }

  private createDefaultTrack(forceReset: boolean): ContextTrack {
    const def: ContextTrack = { id: 'default', name: 'Main', files: [] }

    if (forceReset || !this.tracks.has(def.id)) {
      this.tracks.set(def.id, def)
    }

    if (forceReset || this._trackOrder.length === 0) {
      this._trackOrder = [def.id]
      this.activeTrackId = def.id
    }

    return this.tracks.get(def.id) || def
  }

  private swapTracks(idxA: number, idxB: number): void {
    const temp = this._trackOrder[idxB]
    this._trackOrder[idxB] = this._trackOrder[idxA]
    this._trackOrder[idxA] = temp
    this.requestSave()
    this.fireChange()
  }

  private insertTrackAtTarget(sourceId: string, targetId: string | undefined): void {
    if (!targetId) {
      this._trackOrder.push(sourceId)
      return
    }
    const toIndex = this._trackOrder.indexOf(targetId)
    this._trackOrder.splice(toIndex === -1 ? 0 : toIndex, 0, sourceId)
  }

  private updateFileUri(file: StagedFile, newUri: vscode.Uri): void {
    file.uri = newUri
    refreshFileLabel(file)
  }

  private ensureActiveTrack(): ContextTrack {
    let track = this.tracks.get(this.activeTrackId)
    if (!track) track = this.createDefaultTrack(true)
    return track
  }

  private validateStateIntegrity(): void {
    if (this.tracks.size > 0 && !this.tracks.has(this.activeTrackId)) {
      this.activeTrackId = this._trackOrder[0] || 'default'
    }
    if (this.tracks.size === 0) {
      this.createDefaultTrack(true)
    }
  }

  private handleTrackDeletion(deletedId: string): void {
    if (this.activeTrackId === deletedId) {
      const nextId = this._trackOrder[0] || 'default'
      if (!this.tracks.has(nextId)) this.createDefaultTrack(true)
      void this.switchToTrack(nextId)
    } else {
      this.requestSave()
      this.updateContextKeys()
      this.fireChange()
    }
  }

  private filterNewFiles(track: ContextTrack, uris: vscode.Uri[], fromFolder: boolean): StagedFile[] {
    const existing = new Set(track.files.map((f) => f.uri.toString()))
    return uris
      .filter((u) => !existing.has(u.toString()))
      .map((uri) => ({
        type: 'file',
        uri,
        label: uri.path.split('/').pop() || 'unknown',
        isPinned: false,
        isFromFolderAddition: fromFolder,
      }))
  }
}
