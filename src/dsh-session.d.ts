/**
 * Ambient declaration for @deepseek-ai/dsh-session/types.
 *
 * This file is a script (no top-level import/export) so `declare module` here
 * is an ambient module DECLARATION, not an augmentation. @deepseek-ai/dsh-session
 * is owned by the DSH Host runtime - it is not a dependency of this plugin -
 * so when compiled standalone we declare the surface ourselves. When this
 * plugin is compiled inside a tree that already has the real
 * @deepseek-ai/dsh-session/types, the real interface wins and our
 * 'receipt/printed' entry merges in (declarations are additive).
 */
declare module '@deepseek-ai/dsh-session/types' {
  export interface SessionEventMap {
    [key: string]: unknown
    'receipt/printed': import('./events.js').ReceiptPrintedPayload
  }
}
