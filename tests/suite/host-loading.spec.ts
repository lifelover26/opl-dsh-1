import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'

interface MigrationFixture {
  finished: boolean
  cancelled: Promise<void>
}

interface ExecutionFixture {
  started: boolean
  ready: Promise<void>
}

vi.mock('../../src/gateway/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/shell/host/git-bash.ts', () => ({
  name: 'git-bash-fixture',
  inject: [],
  Config: undefined,
  apply() {
    throw new Error('Git Bash is not installed')
  },
}))
vi.mock('../../src/conversation-stats/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/mcp-apps/host/index.ts', () => ({
  name: 'fixture',
  inject: [],
  Config: undefined,
  apply() {},
}))
vi.mock('../../src/gateway/host/model-service.ts', () => ({ GatewayModelsService() {} }))
vi.mock('../../src/setup/host/index.ts', () => ({ SetupService() {} }))
vi.mock('../../src/updates/host/index.ts', () => ({
  UpdateService: class UpdateService {
    static inject = ['oplUpdateRuntime']
    constructor(ctx: Context) {
      ctx.provide('qualificationUpdatesReady', true)
    }
  },
}))
vi.mock('../../src/updates/host/runtime-admission.ts', () => ({
  installUpdateRuntime: () => ({}),
}))
vi.mock('../../src/shared/host/suite-control.ts', () => ({
  name: 'control-fixture',
  inject: [],
  Config: undefined,
  apply(ctx: Context) {
    ctx.provide('qualificationControlReady', true)
  },
}))
vi.mock('../../src/compat/host/model-providers.ts', () => ({
  name: 'migration-fixture',
  inject: [],
  Config: undefined,
  async apply(ctx: Context) {
    // The Windows keyring migration persists through ConfigEditor.edit. The
    // official editor reconciles the profile and waits for this same Loader.
    const migration = ctx.get('qualificationMigration') as MigrationFixture
    const settled = await Promise.race([
      ctx.loader.await().then(() => true),
      migration.cancelled.then(() => false),
    ])
    if (settled) migration.finished = true
  },
}))
vi.mock('../../src/suite/execution.ts', () => ({
  name: 'execution-fixture',
  inject: ['settings'],
  Config: undefined,
  async apply(ctx: Context, config: unknown) {
    const fixture = ctx.get('qualificationExecution') as ExecutionFixture
    fixture.started = true
    await fixture.ready
    ctx.provide('qualificationExecutionConfig', config)
  },
}))
vi.mock('../../src/auto-review/host/index.ts', () => ({
  default: class AutoReviewService {
    static inject = ['tools']
    constructor(ctx: Context, config: unknown) {
      if (!ctx.get('qualificationExecutionConfig')) throw new Error('Execution is not ready')
      ctx.provide('qualificationReviewConfig', config)
    }
  },
}))

import * as suite from '../../src/suite/host.ts'
import * as executionPlugin from '../../src/suite/execution-plugin.ts'

describe('Suite startup with a profile-writing provider migration', () => {
  it('starts control and updates without Git Bash and lets the migration finish', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    const cancelled = Promise.withResolvers<void>()
    const migration: MigrationFixture = { finished: false, cancelled: cancelled.promise }
    ctx.provide('qualificationMigration', migration)
    ctx.provide('settings', { configure: () => () => {} })
    for (const name of [
      'llm',
      'credentials',
      'sessionProjections',
      'agents',
      'sessions',
      'sessionController',
      'agentDefaultModel',
      'typertGateway',
      'webServer',
      'connection',
    ]) {
      ctx.provide(name, {})
    }
    ctx.loader.builtins['qualification-suite'] = suite
    try {
      const starting = ctx.loader.create({
        id: 'opl-suite',
        name: 'cordis:qualification-suite',
        config: {},
      })
      await vi.waitFor(() => {
        expect(ctx.get('qualificationControlReady')).toBe(true)
        expect(ctx.get('qualificationUpdatesReady')).toBe(true)
      })
      await starting
      await vi.waitFor(() => expect(migration.finished).toBe(true))
    } finally {
      cancelled.resolve()
      await ctx.fiber.dispose()
    }
  })
})

describe('Execution startup', () => {
  it.each([false, true])('mounts the reviewer after execution (opt in: %s)', async (enabled) => {
    const ctx = new Context()
    const ready = Promise.withResolvers<void>()
    const fixture: ExecutionFixture = { started: false, ready: ready.promise }
    ctx.provide('qualificationExecution', fixture)
    ctx.provide('settings', { configure: () => () => {} })
    try {
      const fiber = ctx.plugin(executionPlugin, {
        ...(enabled && { rememberPermissionPreset: true }),
        executionLimits: { enabled, idleProgressMs: 1234 },
        ...(enabled && { toolAutoReview: { enabled: true } }),
      })
      await fiber.await()
      expect(fixture.started).toBe(false)

      ctx.provide('tools', {})
      const activation = fiber.await()
      await Promise.race([activation, vi.waitFor(() => expect(fixture.started).toBe(true))])
      expect(fixture.started).toBe(true)
      expect(ctx.get('qualificationReviewConfig')).toBeUndefined()
      ready.resolve()
      await activation

      expect(ctx.get('qualificationExecutionConfig')).toEqual({
        executionLimits: { enabled, idleProgressMs: 1234, firstProgressMs: 90_000 },
        rememberPermissionPreset: enabled,
      })
      expect(ctx.get('qualificationReviewConfig')).toMatchObject({ enabled })
    } finally {
      ready.resolve()
      await ctx.fiber.dispose()
    }
  })
})
