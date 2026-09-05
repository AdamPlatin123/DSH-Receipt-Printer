/**
 * Minimal StandardSchemaV1 validator (no external Schema helper dependency).
 *
 * Why hand-rolled: @deepseek-ai/cordis v4 uses Standard Schema V1
 * (https://standard-schema.dev) instead of Schemastery. The dsh-TUI docs
 * reference a Schema.object helper from the dsh-TUI toolchain that is not
 * published as a standalone runtime dep. Hand-rolling a 40-line validator
 * keeps this plugin zero-dep beyond cordis itself (KISS).
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
export interface MiniSchemaSpec<T extends object> {
    /** Field defaults - also the canonical key list. */
    defaults: T;
    /** Fields that must be one of the given literals. */
    enums?: {
        [K in keyof T]?: readonly unknown[];
    };
    /** Fields coerced via Number(). */
    numbers?: readonly (keyof T)[];
    /** Fields coerced via Boolean(). */
    booleans?: readonly (keyof T)[];
}
export declare function miniSchema<T extends object>(spec: MiniSchemaSpec<T>): StandardSchemaV1<any, T>;
