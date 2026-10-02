import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(path) ? [path] : []
  }))
  return files.flat().sort()
}

function importSpecifiers(source, path) {
  const specifiers = new Set()
  function visit(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
      : undefined
    if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) specifiers.add(specifier.text)
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest))
  return specifiers
}

await test('all external source imports have a direct package declaration', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const declared = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }))
  const missing = new Map()
  for (const path of await sourceFiles(join(root, 'src'))) {
    for (const specifier of importSpecifiers(await readFile(path, 'utf8'), path)) {
      if (/^(?:[./#]|[a-z][\w+.-]*:)/i.test(specifier) || isBuiltin(specifier)) continue
      const parts = specifier.split('/')
      const dependency = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
      if (declared.has(dependency)) continue
      if (!missing.has(dependency)) missing.set(dependency, new Set())
      missing.get(dependency).add(relative(root, path).replaceAll('\\', '/'))
    }
  }
  const details = [...missing].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([dependency, files]) => `${dependency}: ${[...files].sort().join(', ')}`)
  assert.deepEqual(details, [], `Undeclared source dependencies:\n${details.join('\n')}`)
})
