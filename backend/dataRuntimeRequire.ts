/** Synchronous assertion; direct server.ts startup must fail before business imports. */
if (!(globalThis as any)[Symbol.for('nis.dataRuntimeLock')]) {
  throw new Error('请通过 dataMergeBootstrap.mjs 启动后端；数据保护锁尚未取得')
}
