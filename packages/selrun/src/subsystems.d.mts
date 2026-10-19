export const SUBSYSTEMS: Record<string, string[]>;
export const FALLBACK_PATTERNS: string[];
export const FOUNDATION_FILES: Set<string>;
export const SMOKE_FLOOR: string[];
export function subsystemForFile(file: string): string | null;
export function isFallbackFile(file: string): boolean;
export function isFoundationFile(file: string): boolean;
