import { StagedFile } from './staged-file'

export interface ContextTrack {
  readonly id: string
  name: string
  files: StagedFile[]
}

export interface SerializedFile {
  uri: string
  isPinned: boolean
  isFromFolderAddition?: boolean
}

export interface SerializedTrack {
  id: string
  name: string
  items: SerializedFile[]
}

export interface SerializedState {
  tracks: Record<string, SerializedTrack>
  activeTrackId: string
  trackOrder: string[]
}

export interface ExportedStackFile {
  path: string
  workspaceFolder?: string
  isPinned: boolean
  isFromFolderAddition?: boolean
}

export interface ExportedTrack {
  id: string
  name: string
  files: ExportedStackFile[]
}

export interface StackrExportData {
  version: 1
  exportedAt: string
  activeTrackId: string
  trackOrder: string[]
  tracks: ExportedTrack[]
}
