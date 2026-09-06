/**
 * Minimal StandardSchemaV1 validator (no external Schema helper dependency).
 *
 * Why hand-rolled: @deepseek-ai/cordis v4 uses Standard Schema V1
 * (https://standard-schema.dev) instead of Schemastery. The dsh-TUI docs
 * reference a Schema.object helper from the dsh-TUI toolchain that is not
 * published as a standalone runtime dep. Hand-rolling a 40-line validator
 * keeps this plugin zero-dep beyond cordis itself (KISS).
 */
import type { StandardSchemaV1 } from '@standard-schema/spec'

export interface MiniSchemaSpec<T extends object> {
  /** Field defaults - also the canonical key list. */
  defaults: T
  /** Fields that must be one of the given literals. */
  enums?: { [K in keyof T]?: readonly unknown[] }
  /** Fields coerced via Number(). */
  numbers?: readonly (keyof T)[]
  /** Fields coerced via Boolean(). */
  booleans?: readonly (keyof T)[]
}

export function miniSchema<T extends object>(spec: MiniSchemaSpec<T>): StandardSchemaV1<any, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'dsh-receipt-printer',
      validate(value: unknown): StandardSchemaV1.Result<T> {
        if (value !== undefined && value !== null && typeof value !== 'object') {
          return { issues: [{ message: `config must be an object, got ${typeof value}` }] }
        }
        const input = (value ?? {}) as Record<string, unknown>
        const out: Record<string, unknown> = { ...(spec.defaults as Record<string, unknown>) }
        const issues: { message: string }[] = []

        for (const key of Object.keys(spec.defaults) as (keyof T)[]) {
          if (!(key in input) || input[key as string] === undefined) continue
          let v = input[key as string]
          if (spec.booleans?.includes(key)) v = Boolean(v)
          if (spec.numbers?.includes(key)) {
            const n = Number(v)
            if (Number.isNaN(n)) {
              issues.push({ message: `config.${String(key)} must be a number, got ${JSON.stringify(v)}` })
              continue
            }
            v = n
          }
          const allowed = spec.enums?.[key]
          if (allowed && !allowed.includes(v)) {
            issues.push({
              message: `config.${String(key)} must be one of ${JSON.stringify(allowed)}, got ${JSON.stringify(v)}`,
            })
            continue
          }
          out[key as string] = v
        }
        if (issues.length > 0) return { issues }
        return { value: out as T }
      },
    },
  }
}
