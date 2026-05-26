import fs from 'node:fs'
import path from 'node:path'
import type { FixtureFile } from './schema.js'

export function loadFixture(fixturePath: string): FixtureFile {
  const fullPath = path.resolve(fixturePath)
  const raw = fs.readFileSync(fullPath, 'utf8')
  return JSON.parse(raw) as FixtureFile
}
