import * as zlib from 'zlib'

export interface ZipEntry {
  path: string
  data: Uint8Array
  mtime?: Date
}

const CRC32_TABLE = buildCrc32Table()

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function normalizeZipEntryPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
  const segments = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')

  return segments.join('/')
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()))
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = Math.floor(date.getSeconds() / 2)

  const dosTime = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f)
  const dosDate = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f)

  return { dosTime, dosDate }
}

function deduplicateEntryPath(basePath: string, usedPaths: Set<string>): string {
  if (!usedPaths.has(basePath)) {
    usedPaths.add(basePath)
    return basePath
  }

  const lastSlash = basePath.lastIndexOf('/')
  const dir = lastSlash >= 0 ? basePath.slice(0, lastSlash + 1) : ''
  const fileName = lastSlash >= 0 ? basePath.slice(lastSlash + 1) : basePath
  const lastDot = fileName.lastIndexOf('.')
  const stem = lastDot > 0 ? fileName.slice(0, lastDot) : fileName
  const ext = lastDot > 0 ? fileName.slice(lastDot) : ''

  let counter = 2
  while (true) {
    const candidate = `${dir}${stem} (${counter})${ext}`
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate)
      return candidate
    }
    counter++
  }
}

export function buildZipBuffer(entries: ZipEntry[]): Uint8Array {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  const usedPaths = new Set<string>()

  let offset = 0
  let entryCount = 0

  for (const entry of entries) {
    const cleanPath = normalizeZipEntryPath(entry.path)
    if (!cleanPath) {
      continue
    }

    const uniquePath = deduplicateEntryPath(cleanPath, usedPaths)
    const nameBytes = Buffer.from(uniquePath, 'utf8')
    const rawData = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
    const checksum = crc32(rawData)
    const deflated = rawData.length > 0 ? zlib.deflateRawSync(rawData) : Buffer.alloc(0)
    const useDeflate = rawData.length > 0 && deflated.length < rawData.length
    const payload = useDeflate ? deflated : rawData
    const compressionMethod = useDeflate ? 8 : 0
    const { dosTime, dosDate } = toDosTimeDate(entry.mtime ?? new Date())

    // General purpose bit flag: bit 11 (0x0800) = UTF-8 filename encoding
    const flags = 0x0800

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0) // Local file header signature
    localHeader.writeUInt16LE(20, 4) // Version needed to extract (2.0)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(compressionMethod, 8)
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(payload.length, 18)
    localHeader.writeUInt32LE(rawData.length, 22)
    localHeader.writeUInt16LE(nameBytes.length, 26)
    localHeader.writeUInt16LE(0, 28) // Extra field length

    localParts.push(localHeader, nameBytes, payload)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0) // Central directory file header signature
    centralHeader.writeUInt16LE(20, 4) // Version made by
    centralHeader.writeUInt16LE(20, 6) // Version needed to extract
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(compressionMethod, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(payload.length, 20)
    centralHeader.writeUInt32LE(rawData.length, 24)
    centralHeader.writeUInt16LE(nameBytes.length, 28)
    centralHeader.writeUInt16LE(0, 30) // Extra field length
    centralHeader.writeUInt16LE(0, 32) // File comment length
    centralHeader.writeUInt16LE(0, 34) // Disk number start
    centralHeader.writeUInt16LE(0, 36) // Internal file attributes
    centralHeader.writeUInt32LE(0, 38) // External file attributes
    centralHeader.writeUInt32LE(offset, 42) // Relative offset of local header

    centralParts.push(centralHeader, nameBytes)

    offset += localHeader.length + nameBytes.length + payload.length
    entryCount++
  }

  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // End of central directory signature
  eocd.writeUInt16LE(0, 4) // Number of this disk
  eocd.writeUInt16LE(0, 6) // Disk where central directory starts
  eocd.writeUInt16LE(entryCount, 8) // Entries on this disk
  eocd.writeUInt16LE(entryCount, 10) // Total entries
  eocd.writeUInt32LE(centralDirectory.length, 12) // Size of central directory
  eocd.writeUInt32LE(offset, 16) // Offset of start of central directory
  eocd.writeUInt16LE(0, 20) // Comment length

  return new Uint8Array(Buffer.concat([...localParts, centralDirectory, eocd]))
}
