/**
 * WGSL memory layout, computed in TypeScript.
 *
 * Uniform/storage buffer layout mismatches are the single most common cause of "everything
 * renders as garbage" bugs in WebGPU, and they are silent: the GPU reads whatever bytes happen to
 * be at the offset it computed from the shader's own idea of the layout. So the layout is not
 * hand-computed in comments — it is *computed* here from the same field definitions used to write
 * the bytes, and verified against the `.wgsl` source text by `tools/wgsl-check.mjs` (which parses
 * the `struct` declarations and compares offsets field by field).
 *
 * Rules implemented (WGSL "Structure Layout Rules", float-only members):
 *   align:  i32/u32/f32/bool = 4 | vec2 = 8 | vec3 = 16 | vec4 = 16
 *            matNx2 = 8 | matNx3 = 16 | matNx4 = 16
 *   size:   scalars = 4 | vec2 = 8 | vec3 = 12 | vec4 = 16
 *            mat2x2 = 16 | mat3x3 = 48 | mat4x4 = 64 (column stride = align)
 *   struct: align = max(member align) (≥ 8 in uniform), size = roundUp(last member end, align)
 *   array:  in uniform/storage, element stride = roundUp(element size, 16);
 *           struct members in an array are 16-aligned
 * Padding between members is inserted by rounding the running offset up to the member alignment.
 */

import { UsageError } from "../core/errors.js";
import { alignUp } from "../math/scalar.js";

export type AddressSpace = "uniform" | "storage" | "read_write_storage";

export type FieldType =
  | { kind: "f32" }
  | { kind: "i32" }
  | { kind: "u32" }
  | { kind: "bool" }
  | { kind: "vec2" }
  | { kind: "vec3" }
  | { kind: "vec4" }
  | { kind: "mat2x2" }
  | { kind: "mat3x3" }
  | { kind: "mat4x4" }
  | { kind: "array"; element: FieldType; count: number }
  | { kind: "struct"; struct: StructDef };

export const f32: FieldType = { kind: "f32" };
export const i32: FieldType = { kind: "i32" };
export const u32: FieldType = { kind: "u32" };
export const bool_: FieldType = { kind: "bool" };
export const vec2: FieldType = { kind: "vec2" };
export const vec3: FieldType = { kind: "vec3" };
export const vec4: FieldType = { kind: "vec4" };
export const mat2x2: FieldType = { kind: "mat2x2" };
export const mat3x3: FieldType = { kind: "mat3x3" };
export const mat4x4: FieldType = { kind: "mat4x4" };
export const arrayOf = (element: FieldType, count: number): FieldType => ({ kind: "array", element, count });
export const ofStruct = (struct: StructDef): FieldType => ({ kind: "struct", struct });

export interface FieldDef {
  name: string;
  type: FieldType;
  /** Document only: emitted into generated WGSL comments. */
  comment?: string;
}

export interface FieldLayout {
  name: string;
  offset: number;
  size: number;
  align: number;
  type: FieldType;
  /** Present for arrays. */
  stride?: number;
  count?: number;
}

export function alignOf(type: FieldType, space: AddressSpace): number {
  switch (type.kind) {
    case "f32":
    case "i32":
    case "u32":
    case "bool":
      return 4;
    case "vec2":
      return 8;
    case "vec3":
    case "vec4":
      return 16;
    case "mat2x2":
      return 8;
    case "mat3x3":
    case "mat4x4":
      return 16;
    case "array": {
      const inner = alignOf(type.element, space);
      return space === "uniform" ? Math.max(16, inner) : inner;
    }
    case "struct":
      return type.struct.align(space);
  }
}

export function sizeOf(type: FieldType, space: AddressSpace): number {
  switch (type.kind) {
    case "f32":
    case "i32":
    case "u32":
    case "bool":
      return 4;
    case "vec2":
      return 8;
    case "vec3":
      return 12;
    case "vec4":
      return 16;
    case "mat2x2":
      return 2 * 8;
    case "mat3x3":
      return 3 * 16;
    case "mat4x4":
      return 4 * 16;
    case "array":
      return strideOf(type.element, space) * type.count;
    case "struct":
      return type.struct.size(space);
  }
}

/** Element stride inside an array of `type` (arrays pad elements to 16 in uniform/storage). */
export function strideOf(type: FieldType, space: AddressSpace): number {
  const size = sizeOf(type, space);
  const align = alignOf(type, space);
  if (type.kind === "vec3") return 16;
  return alignUp(size, Math.max(space === "uniform" ? 16 : align, align));
}

export class StructDef {
  private cache = new Map<AddressSpace, FieldLayout[]>();

  constructor(
    readonly name: string,
    readonly fields: readonly FieldDef[],
  ) {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.name)) throw new UsageError(`${name}: duplicate field "${f.name}"`);
      seen.add(f.name);
    }
  }

  layouts(space: AddressSpace): FieldLayout[] {
    const cached = this.cache.get(space);
    if (cached) return cached;
    const out: FieldLayout[] = [];
    let offset = 0;
    for (const field of this.fields) {
      const align = alignOf(field.type, space);
      offset = alignUp(offset, align);
      const size = sizeOf(field.type, space);
      const layout: FieldLayout = {
        name: field.name,
        offset,
        size,
        align,
        type: field.type,
      };
      if (field.type.kind === "array") {
        layout.stride = strideOf(field.type.element, space);
        layout.count = field.type.count;
      }
      out.push(layout);
      offset += size;
    }
    this.cache.set(space, out);
    return out;
  }

  field(name: string, space: AddressSpace): FieldLayout {
    const f = this.layouts(space).find((l) => l.name === name);
    if (!f) throw new UsageError(`${this.name} has no field "${name}" (fields: ${this.fields.map((x) => x.name).join(", ")})`);
    return f;
  }

  offsetOf(name: string, space: AddressSpace = "uniform"): number {
    return this.field(name, space).offset;
  }

  align(space: AddressSpace): number {
    let a = space === "uniform" ? 8 : 4;
    for (const f of this.fields) a = Math.max(a, alignOf(f.type, space));
    return a;
  }

  size(space: AddressSpace): number {
    const fields = this.layouts(space);
    if (fields.length === 0) return 0;
    const last = fields[fields.length - 1]!;
    return alignUp(last.offset + last.size, this.align(space));
  }

  /** Byte size rounded to the alignment WebGPU requires for a binding's resource size. */
  byteSize(space: AddressSpace = "uniform"): number {
    return this.size(space);
  }

  /** Emit the WGSL struct. Used by the layout checker as the reference to compare against. */
  toWgsl(space: AddressSpace = "uniform"): string {
    const lines: string[] = [`struct ${this.name} {`];
    let prevEnd = 0;
    for (const f of this.layouts(space)) {
      if (f.offset > prevEnd) {
        lines.push(`  __pad${prevEnd}: array<u32, ${(f.offset - prevEnd) / 4}>; // alignment padding`);
      }
      const def = this.fields.find((x) => x.name === f.name)!;
      const type = wgslType(f.type, space);
      const comment = def.comment ? ` // ${def.comment}` : "";
      lines.push(`  ${f.name}: ${type};${comment}`);
      prevEnd = f.offset + f.size;
    }
    const pad = this.size(space) - prevEnd;
    if (pad > 0) lines.push(`  __pad${prevEnd}: array<u32, ${pad / 4}>; // trailing padding`);
    lines.push("}");
    return lines.join("\n");
  }

}

function wgslType(type: FieldType, space: AddressSpace): string {
  switch (type.kind) {
    case "f32":
      return "f32";
    case "i32":
      return "i32";
    case "u32":
      return "u32";
    case "bool":
      return "bool";
    case "vec2":
      return "vec2<f32>";
    case "vec3":
      return "vec3<f32>";
    case "vec4":
      return "vec4<f32>";
    case "mat2x2":
      return "mat2x2<f32>";
    case "mat3x3":
      return "mat3x3<f32>";
    case "mat4x4":
      return "mat4x4<f32>";
    case "array":
      return `array<${wgslType(type.element, space)}, ${type.count}>`;
    case "struct":
      return type.struct.name;
  }
}

/**
 * Validate that a WGSL `struct` declaration (parsed from a shader source) matches a StructDef.
 * Returns the list of mismatches (empty = match). Used by the shader checker and by tests so a
 * shader edit that changes layout cannot silently desynchronize from the CPU writer.
 */
export function diffWgslStruct(wgslFields: { name: string; type: string }[], def: StructDef, space: AddressSpace = "uniform"): string[] {
  const problems: string[] = [];
  const ours = def.layouts(space);
  const theirs = wgslFields.filter((f) => !f.name.startsWith("__pad"));
  if (ours.length !== theirs.length) {
    problems.push(`${def.name}: WGSL declares ${theirs.length} fields, TS layout declares ${ours.length}`);
  }
  for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
    const a = ours[i]!;
    const b = theirs[i]!;
    if (a.name !== b.name) {
      problems.push(`${def.name}[${i}]: name mismatch (WGSL "${b.name}" vs TS "${a.name}")`);
      continue;
    }
    const expectedType = wgslType(a.type, space).replace(/\s+/g, "");
    const actualType = b.type.replace(/\s+/g, "");
    if (expectedType !== actualType) {
      problems.push(`${def.name}.${a.name}: type mismatch (WGSL "${actualType}" vs TS "${expectedType}")`);
    }
  }
  return problems;
}

export { sizeOf as wgslSizeOf, alignOf as wgslAlignOf, strideOf as wgslStrideOf };
