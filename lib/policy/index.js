/**
 * Ported from the Crescent project (aide-family/Crescent),
 *   src/shared/command-guard.ts
 *   src/shared/shell-command.ts
 *   src/shared/command-policy/{types,argv,shell-wrappers,sudo,ssh,systemctl,kubectl,docker,inspection}.ts
 *
 * dsh-remote policy contract (see docs/ARCHITECTURE.md, "Policy contract").
 * Pure, synchronous, no I/O, no network, no @deepseek-ai imports.
 *
 *   classifyCommand(command) -> { level: "low" | "gray" | "high", verb: string }
 *   isStaticallyReadonly(command) -> boolean   (=== level === "low")
 *   hasHighWriteVerb(command) -> boolean       (=== level === "high")
 *   extractRiskVerb(command) -> string         (best verb for a human summary)
 */

export {
  classifyCommand,
  extractRiskVerb,
  hasHighWriteVerb,
  isStaticallyReadonly
} from './command-guard.js'
