type CheckDetails = { cmd?: string; ok?: boolean; exitCode?: number | null }

/** One native agent's evidence. Reset per accepted round; never reuse a prior check. */
export function createPresetPlanCheck(command: string) {
  let revision = 0
  let passed = false
  const invalidate = () => { revision++; passed = false }
  return {
    command,
    invalidate,
    begin(cmd: string, cwd?: string, readOnly?: boolean) {
      if (cmd.trim() !== command || cwd || readOnly === false) return
      invalidate()
      const current = revision
      return (details?: CheckDetails) => {
        if (current === revision) passed = details?.cmd === command && details.ok === true && details.exitCode === 0
      }
    },
    blockCompletion(items: readonly { done: boolean }[]) {
      return !passed && items.length > 0 && items.every(item => item.done)
    },
    reason: `预设要求验收：请在当前工作区用 check_run 运行「${command}」。未通过前不能完成计划。`,
  }
}

export type PresetPlanCheck = ReturnType<typeof createPresetPlanCheck>
