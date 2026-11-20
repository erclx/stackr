import * as assert from 'assert'
import * as vscode from 'vscode'

import { parseCopiedTabPaths, resolveTargets } from '../../commands/add-file-context-menu'
import { parseGitNameOnlyZ, parseGitPorcelainZ } from '../../commands/add-git-files'
import { isStagedFolder, StagedFile } from '../../models'
import { TreeBuilder } from '../../services'
import { buildZipBuffer, ContentFormatter, crc32, normalizeZipEntryPath } from '../../utils'

suite('Stackr New Features Test Suite', () => {
  suite('Zip Builder', () => {
    test('normalizeZipEntryPath converts backslashes and strips traversal segments', () => {
      assert.strictEqual(normalizeZipEntryPath('src\\utils\\zip-builder.ts'), 'src/utils/zip-builder.ts')
      assert.strictEqual(normalizeZipEntryPath('/leading/slash/../file.ts'), 'leading/slash/file.ts')
      assert.strictEqual(normalizeZipEntryPath('C:\\repo\\src\\index.ts'), 'repo/src/index.ts')
    })

    test('crc32 matches standard IEEE 802.3 vector', () => {
      const data = new TextEncoder().encode('123456789')
      assert.strictEqual(crc32(data), 0xcbf43926)
    })

    test('buildZipBuffer produces valid ZIP structure with mirrored folder paths', () => {
      const zip = buildZipBuffer([
        { path: 'src/a.ts', data: new TextEncoder().encode('export const a = 1\n') },
        { path: 'src/nested/b.ts', data: new TextEncoder().encode('export const b = 2\n') },
      ])

      const buf = Buffer.from(zip)
      assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'Must start with local file header signature')
      assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'Must end with EOCD signature')
      assert.strictEqual(buf.readUInt16LE(buf.length - 12), 2, 'Total entry count must be 2')
    })
  })

  suite('Multi-Source Target Resolution (Explorer, Git SCM, Tabs)', () => {
    test('resolves Explorer multi-select (clickedUri, selectedUris[])', () => {
      const u1 = vscode.Uri.file('/workspace/a.ts')
      const u2 = vscode.Uri.file('/workspace/b.ts')
      const result = resolveTargets(u1, [u1, u2])
      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0].fsPath, u1.fsPath)
      assert.strictEqual(result[1].fsPath, u2.fsPath)
    })

    test('resolves variadic Git SCM SourceControlResourceState args', () => {
      const u1 = vscode.Uri.file('/workspace/staged1.ts')
      const u2 = vscode.Uri.file('/workspace/staged2.ts')
      const result = resolveTargets({ resourceUri: u1 }, { resourceUri: u2 })
      assert.strictEqual(result.length, 2)
      assert.strictEqual(result[0].fsPath, u1.fsPath)
      assert.strictEqual(result[1].fsPath, u2.fsPath)
    })

    test('resolves Git SCM SourceControlResourceGroup arg', () => {
      const u1 = vscode.Uri.file('/workspace/change1.ts')
      const u2 = vscode.Uri.file('/workspace/change2.ts')
      const group = { resourceStates: [{ resourceUri: u1 }, { resourceUri: u2 }] }
      const result = resolveTargets(group)
      assert.strictEqual(result.length, 2)
    })

    test('deduplicates overlapping URIs across arguments', () => {
      const u1 = vscode.Uri.file('/workspace/dup.ts')
      const result = resolveTargets(u1, { resourceUri: u1 })
      assert.strictEqual(result.length, 1)
    })

    test('parseCopiedTabPaths extracts multi-selected tab paths and validates anchor membership', () => {
      const sentinel = '__sentinel__'
      const copied = '/workspace/a.ts\n/workspace/b.ts\r\n/workspace/c.ts'
      const paths = parseCopiedTabPaths(copied, sentinel, '/workspace/b.ts')
      assert.deepStrictEqual(paths, ['/workspace/a.ts', '/workspace/b.ts', '/workspace/c.ts'])

      assert.deepStrictEqual(parseCopiedTabPaths(sentinel, sentinel, '/workspace/b.ts'), [])
      assert.deepStrictEqual(parseCopiedTabPaths('/workspace/a.ts', sentinel, '/workspace/a.ts'), [])
      assert.deepStrictEqual(parseCopiedTabPaths('/workspace/a.ts\n/workspace/c.ts', sentinel, '/workspace/b.ts'), [])
    })
  })

  suite('Git Porcelain & Diff Parsers', () => {
    test('parseGitPorcelainZ parses changed, staged, renamed, untracked, and skips deleted', () => {
      const sample =
        [
          'M  src/staged.ts',
          ' M src/modified.ts',
          '?? src/untracked.ts',
          'R  src/new-name.ts',
          'src/old-name.ts',
          ' D src/deleted-wt.ts',
          'D  src/deleted-idx.ts',
        ].join('\0') + '\0'

      assert.deepStrictEqual(parseGitPorcelainZ(sample, 'all'), [
        'src/staged.ts',
        'src/modified.ts',
        'src/untracked.ts',
        'src/new-name.ts',
      ])

      assert.deepStrictEqual(parseGitPorcelainZ(sample, 'staged'), ['src/staged.ts', 'src/new-name.ts'])
    })

    test('parseGitNameOnlyZ splits NUL-delimited diff output', () => {
      assert.deepStrictEqual(parseGitNameOnlyZ('a.ts\0src/b c.ts\0'), ['a.ts', 'src/b c.ts'])
    })
  })

  suite('TreeBuilder.getParent & Sort by Token Count', () => {
    test('tracks parent folders for nested files and folders', async () => {
      const builder = new TreeBuilder()
      const rootFile: StagedFile = {
        type: 'file',
        uri: vscode.Uri.file('/root.ts'),
        label: 'root.ts',
        pathSegments: ['root.ts'],
      }
      const nestedFile: StagedFile = {
        type: 'file',
        uri: vscode.Uri.file('/src/utils/helper.ts'),
        label: 'helper.ts',
        pathSegments: ['src', 'utils', 'helper.ts'],
      }

      const roots = await builder.buildAsync([rootFile, nestedFile])
      assert.strictEqual(builder.getParent(rootFile), undefined)

      const srcFolder = roots.find((item) => isStagedFolder(item) && item.label === 'src')
      assert.ok(srcFolder && isStagedFolder(srcFolder))
      assert.strictEqual(builder.getParent(srcFolder), undefined)

      const utilsFolder = srcFolder.children.find((item) => isStagedFolder(item) && item.label === 'utils')
      assert.ok(utilsFolder && isStagedFolder(utilsFolder))
      assert.strictEqual(builder.getParent(utilsFolder), srcFolder)
      assert.strictEqual(builder.getParent(nestedFile), utilsFolder)
    })

    test('sorts files by token count descending while keeping pinned items first', async () => {
      const builder = new TreeBuilder()
      builder.setSortOrder('tokensDesc')

      const smallPinned: StagedFile = {
        type: 'file',
        uri: vscode.Uri.file('/small-pinned.ts'),
        label: 'small-pinned.ts',
        pathSegments: ['small-pinned.ts'],
        isPinned: true,
        stats: { tokenCount: 50, charCount: 200 },
      }
      const medium: StagedFile = {
        type: 'file',
        uri: vscode.Uri.file('/a-medium.ts'),
        label: 'a-medium.ts',
        pathSegments: ['a-medium.ts'],
        stats: { tokenCount: 500, charCount: 2000 },
      }
      const large: StagedFile = {
        type: 'file',
        uri: vscode.Uri.file('/z-large.ts'),
        label: 'z-large.ts',
        pathSegments: ['z-large.ts'],
        stats: { tokenCount: 4000, charCount: 16000 },
      }

      const roots = await builder.buildAsync([medium, large, smallPinned])
      assert.deepStrictEqual(
        roots.map((r) => r.label),
        ['small-pinned.ts', 'z-large.ts', 'a-medium.ts'],
      )
    })
  })

  suite('ContentFormatter Context Map Only', () => {
    test('formats ASCII context map without reading file contents when skipContents is true', async () => {
      const files: StagedFile[] = [
        { type: 'file', uri: vscode.Uri.file('/nonexistent-a.ts'), label: 'nonexistent-a.ts' },
        { type: 'file', uri: vscode.Uri.file('/nonexistent-b.ts'), label: 'nonexistent-b.ts' },
      ]

      const output = await ContentFormatter.format(files, { forceTree: true, skipContents: true })
      assert.ok(output.includes('```'), 'Output should contain fenced tree block')
      assert.ok(output.includes('nonexistent-a.ts'), 'Output should include first file path')
      assert.ok(output.includes('nonexistent-b.ts'), 'Output should include second file path')
      assert.ok(!output.includes('File: '), 'Output should not include file content blocks')
    })
  })
})
