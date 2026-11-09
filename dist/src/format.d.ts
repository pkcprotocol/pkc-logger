export interface FormatOptions {
    /** Hard cap on the formatted string's length (UTF-16 code units). Default 16 KiB. */
    maxLength?: number;
    /** Nesting depth before an object collapses to `[Object]` / `[Array]`. Default 4. */
    maxDepth?: number;
    /** Array / Map / Set elements rendered before `... N more`. Default 50. */
    maxArrayLength?: number;
    /** Object keys rendered before `... N more`. Default 50. */
    maxKeys?: number;
    /** Nested string values longer than this are truncated. Default 2000. */
    maxStringLength?: number;
}
export declare const TRUNCATION_MARKER = "\u2026[truncated]";
/** Formats a log call's arguments into one bounded, color-free string. */
export declare function formatLogArgs(args: unknown[], options?: FormatOptions): string;
