import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCAL_FILE_MAX_BYTES, listLocalDirectory, readLocalFile, writeLocalFile } from './local-file-tools'

let workspace: string
beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'pi-local-files-')) })
afterEach(() => { rmSync(workspace, { recursive: true, force: true }) })
const args = (path = 'note.txt') => ({ workspace, path })

describe('workspace text tools', () => {
  it('lists a bounded directory without reading entries or following directory links', () => {
    writeFileSync(join(workspace, 'b.txt'), 'secret-b')
    writeFileSync(join(workspace, 'a.txt'), 'secret-a')
    mkdirSync(join(workspace, 'folder'))
    symlinkSync(join(workspace, 'folder'), join(workspace, 'linked-folder'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(listLocalDirectory(workspace, { ...args('.'), limit: 2 })).toEqual({
      path: '.',
      entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ],
      truncated: true,
    })
    expect(listLocalDirectory(workspace, { ...args('folder'), limit: 10 })).toEqual({
      path: 'folder', entries: [], truncated: false,
    })
    expect(() => listLocalDirectory(workspace, { ...args('linked-folder'), limit: 10 })).toThrow('Symbolic links')
  })

  it.each([0, 201, 1.5, '10'])('rejects an invalid directory listing limit: %s', (limit) => {
    expect(() => listLocalDirectory(workspace, { ...args('.'), limit })).toThrow('arguments.limit')
  })

  it('round trips Unicode text and empty files, with byte counts', () => {
    const content = 'hello \u4e16\u754c\n'
    expect(writeLocalFile(workspace, { ...args(), content })).toMatchObject({ bytes: Buffer.byteLength(content) })
    expect(readLocalFile(workspace, args())).toMatchObject({ content, encoding: 'utf-8' })
    writeLocalFile(workspace, { ...args('empty'), content: '' })
    expect(readLocalFile(workspace, args('empty'))).toMatchObject({ content: '', bytes: 0 })
  })

  it('refuses to overwrite by default and replaces only when explicitly requested', () => {
    writeFileSync(join(workspace, 'note.txt'), 'original')
    expect(() => writeLocalFile(workspace, { ...args(), content: 'replacement' })).toThrow()
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('original')
    writeLocalFile(workspace, { ...args(), content: 'replacement', overwrite: true })
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('replacement')
  })

  it.each(['../outside', 'sub/../../outside', 'C:\\secret', '/secret', 'a:stream', 'NUL', 'a./b'])('rejects unsafe paths: %s', (path) => {
    expect(() => writeLocalFile(workspace, { ...args(path), content: 'bad' })).toThrow()
  })

  it('requires the active workspace to match the explicit workspace', () => {
    expect(() => readLocalFile(null, args())).toThrow('No workspace')
    expect(() => writeLocalFile(workspace, { path: 'a', content: '' })).toThrow('arguments.workspace')
    mkdirSync(join(workspace, 'other'))
    expect(() => writeLocalFile(workspace, { ...args(), workspace: join(workspace, 'other'), content: '' })).toThrow('not the active workspace')
  })

  it('rejects directory links, including Windows junctions', () => {
    mkdirSync(join(workspace, 'actual'))
    symlinkSync(join(workspace, 'actual'), join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => writeLocalFile(workspace, { ...args('link/note'), content: '' })).toThrow('Symbolic links')
  })

  it('rejects directories, missing parents and missing files', () => {
    mkdirSync(join(workspace, 'dir'))
    expect(() => readLocalFile(workspace, args('dir'))).toThrow('regular file')
    expect(() => writeLocalFile(workspace, { ...args('missing/note'), content: '' })).toThrow()
    expect(() => readLocalFile(workspace, args('missing'))).toThrow()
  })

  it('bounds reads and writes by UTF-8 bytes and preserves old data on rejection', () => {
    writeFileSync(join(workspace, 'note.txt'), 'original')
    expect(() => writeLocalFile(workspace, { ...args(), content: '\u4e16'.repeat(LOCAL_FILE_MAX_BYTES / 2), overwrite: true })).toThrow('64 KiB')
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe('original')
    writeFileSync(join(workspace, 'big'), Buffer.alloc(LOCAL_FILE_MAX_BYTES + 1))
    expect(() => readLocalFile(workspace, args('big'))).toThrow('64 KiB')
  })

  it('rejects binary data, invalid UTF-8 and invalid write options', () => {
    writeFileSync(join(workspace, 'binary'), Buffer.from([0]))
    writeFileSync(join(workspace, 'invalid'), Buffer.from([0xff]))
    expect(() => readLocalFile(workspace, args('binary'))).toThrow('Binary')
    expect(() => readLocalFile(workspace, args('invalid'))).toThrow('UTF-8')
    expect(() => writeLocalFile(workspace, { ...args(), content: '\ud800' })).toThrow('Unicode')
    expect(() => writeLocalFile(workspace, { ...args(), content: '', overwrite: 'false' })).toThrow('boolean')
  })
})
