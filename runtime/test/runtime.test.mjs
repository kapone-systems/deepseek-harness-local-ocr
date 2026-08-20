import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { doctor, getPaths, modelStatus, readJson, status, writeConfig } from '../src/runtime.mjs'

test('runtime accepts only pathless loopback service URLs', () => {
  const paths = getPaths({ stateDir: path.join(os.tmpdir(), 'dsh-ocr-test'), url: 'http://127.0.0.1:8765' })
  assert.equal(paths.serviceUrl, 'http://127.0.0.1:8765')
  assert.throws(() => getPaths({ url: 'http://localhost:8765' }), /loopback/)
  assert.throws(() => getPaths({ url: 'https://127.0.0.1:8765' }), /loopback/)
  assert.throws(() => getPaths({ url: 'http://127.0.0.1:8765/v1' }), /pathless/)
})

test('model status is explicit before and after consent/cache artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-model-'))
  const paths = getPaths({ stateDir: root, modelCacheDir: path.join(root, 'models') })
  assert.equal(modelStatus(paths).status, 'consent_required')
  await fs.mkdir(paths.modelCacheDir, { recursive: true })
  await fs.writeFile(paths.consentFile, '{}')
  assert.equal(modelStatus(paths).status, 'not_downloaded')
  await fs.mkdir(path.join(paths.modelCacheDir, 'official_models'), { recursive: true })
  assert.equal(modelStatus(paths).status, 'not_downloaded')
  await fs.writeFile(path.join(paths.modelCacheDir, 'model.marker'), 'test')
  const ready = modelStatus(paths)
  assert.equal(ready.status, 'ready')
  assert.equal(ready.version, '3.7.0')
  assert.equal(ready.model, 'PP-OCRv6 medium det/rec + textline orientation')
})

test('runtime config is written as JSON outside the repository', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-config-'))
  const paths = getPaths({ stateDir: root })
  await writeConfig(paths, { setupStatus: 'ready', serviceUrl: paths.serviceUrl })
  assert.deepEqual(await readJson(paths.configFile), { setupStatus: 'ready', serviceUrl: paths.serviceUrl })
})

test('status distinguishes incomplete setup and a missing model from a stopped service', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-status-'))
  const paths = getPaths({ stateDir: root, modelCacheDir: path.join(root, 'models') })

  await writeConfig(paths, { setupStatus: 'failed', serviceUrl: paths.serviceUrl })
  assert.deepEqual((await status({ stateDir: root })).state, 'not_installed')

  await writeConfig(paths, {
    setupStatus: 'ready',
    serviceUrl: paths.serviceUrl,
    modelCacheDir: paths.modelCacheDir,
  })
  await fs.writeFile(paths.consentFile, '{}')
  const modelNotReady = await status({ stateDir: root })
  assert.equal(modelNotReady.state, 'model_not_ready')
  assert.equal(modelNotReady.code, 'OCR_MODEL_NOT_READY')
})

test('doctor reports when a local OCR profile is missing the Web bundle', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-profile-'))
  const dshHome = path.join(root, 'dsh-home')
  const profileDir = path.join(dshHome, 'profiles', 'local-ocr')
  await fs.mkdir(path.join(profileDir, 'node_modules', 'dsh-plugin-local-ocr'), { recursive: true })
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-local-ocr'] } },
  }))
  await fs.writeFile(path.join(profileDir, 'cordis.patch.yml'), [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-local-ocr',
    '    model: deepseek-v4-flash',
  ].join('\n'))
  await fs.writeFile(path.join(profileDir, 'node_modules', 'dsh-plugin-local-ocr', 'package.json'), JSON.stringify({ version: '0.2.0' }))

  const previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  t.after(async () => {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
    await fs.rm(root, { recursive: true, force: true })
  })

  const result = await doctor({ stateDir: path.join(root, 'runtime') })
  const check = result.checks.find((entry) => entry.name === 'dsh_web_bundle')
  assert.equal(check?.status, 'warning')
  assert.match(check?.fix ?? '', /@deepseek-ai\/dsh-web-app@0\.1\.0-rc\.6/)
  const modelSelection = result.checks.find((entry) => entry.name === 'model_selection')
  assert.equal(modelSelection?.status, 'warning')
  assert.equal(modelSelection?.code, 'OCR_LEGACY_DEFAULT_MODEL')
  assert.match(modelSelection?.fix ?? '', /install-plugin\.ps1/)
})
