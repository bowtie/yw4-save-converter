import { describe, expect, it } from "vitest";
import {
  buildConversion,
  buildSkeleton,
  convertBigSave,
  convertHeadersave,
  detectSide,
  extractPlayerName,
  parseSave,
  KEY_TZ_TABLE,
  KEY_PLAYER_NAMES,
  type ParsedSave,
} from "./converter";
import { classifyPs4Files, classifySwitchFiles, type DroppedFile } from "./file-selection";
import { TAIL_SIZE } from "./skeleton-data";

// ── Synthetic YW4++ save fixtures ──────────────────────────────────────────

interface TestRecord {
  key: number;
  value: Uint8Array;
  flags?: number;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function buildSection(type: number, ident: number, records: TestRecord[]): Uint8Array {
  const body: Uint8Array[] = [];
  for (const rec of records) {
    const header = new Uint8Array(8);
    const view = new DataView(header.buffer);
    view.setUint32(0, rec.key, true);
    view.setUint16(4, rec.value.length, true);
    view.setUint16(6, rec.flags ?? 0, true);
    body.push(header, rec.value);
  }
  const bodyLength = body.reduce((n, c) => n + c.length, 0);
  // section: 16-byte header + records + 8-byte marker + 4-byte ff ef 00 00
  const section = new Uint8Array(16 + bodyLength + 12);
  const view = new DataView(section.buffer);
  section[0] = 0xee;
  section[1] = 0xff;
  view.setUint16(2, type, true);
  view.setUint32(4, 16 + bodyLength, true); // idxSize = offset of marker
  view.setUint32(8, ident, true);
  view.setUint32(12, 0x01000000, true);
  let off = 16;
  for (const chunk of body) {
    section.set(chunk, off);
    off += chunk.length;
  }
  view.setUint32(off, ident, true); // marker: ident, 0, 0x0200
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0x0200, true);
  section[off + 8] = 0xff;
  section[off + 9] = 0xef;
  return section;
}

const IDENT_A = 0x00bda133;
const IDENT_C = 0x84f7afc9;

function buildBigSave(opts: {
  side: "switch" | "ps4";
  names: string;
  progressA: number;
  progressB: number;
  tailFill: number;
  /** Total byte span of the bulk section (defaults to a tiny fixture size). */
  tailSpan?: number;
}): Uint8Array {
  // Section 0: a few records including the platform-telling tz table.
  const tzLen = opts.side === "switch" ? 208 : 1;
  const names = new TextEncoder().encode(opts.names);
  const nameValue = new Uint8Array(72);
  nameValue.set(names.subarray(0, 36));
  const secA = buildSection(0x1001, IDENT_A, [
    { key: 0x17e84b00, value: u32(1) },
    { key: KEY_PLAYER_NAMES, value: nameValue },
    { key: KEY_TZ_TABLE, value: new Uint8Array(tzLen) },
    { key: 0x12345678, value: u32(opts.progressA) },
  ]);
  const secB = buildSection(0x1002, IDENT_A, [
    { key: 0xc855d2ce, value: new Uint8Array(opts.side === "switch" ? 8 : 4) },
    { key: 0x87654321, value: u32(opts.progressB) },
  ]);
  const tailSpan = opts.tailSpan ?? 36 + opts.tailFill;
  const secC = buildSection(0x1003, IDENT_C, [
    { key: 0xdeadbeef, value: new Uint8Array(tailSpan - 36).fill(0xaa) },
  ]);
  return concat([secA, secB, secC]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ── Parser ─────────────────────────────────────────────────────────────────

describe("parseSave", () => {
  it("rejects a non-save file", () => {
    expect(() =>
      parseSave(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])),
    ).toThrow(/Not a Yo-kai Watch/);
  });

  it("round-trips sections and records", () => {
    const save = buildBigSave({
      side: "ps4",
      names: "Tester",
      progressA: 7,
      progressB: 9,
      tailFill: 16,
    });
    const parsed = parseSave(save);
    expect(parsed.sections).toHaveLength(3);
    expect(parsed.sections[0].type).toBe(0x1001);
    expect(parsed.sections[0].records).toHaveLength(4);
    const rec = parsed.sections[0].records.find((r) => r.key === 0x12345678);
    expect(rec).toBeDefined();
    expect(recordU32(parsed, rec!.offset)).toBe(7);
  });
});

/** Read a record's first 4 bytes as a little-endian u32 (test helper). */
function recordU32(parsed: ParsedSave, recordOffset: number): number {
  const len = new DataView(parsed.data.buffer, parsed.data.byteOffset).getUint16(
    recordOffset + 4,
    true,
  );
  const value = parsed.data.subarray(recordOffset + 8, recordOffset + 8 + len);
  return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, true);
}

// ── Detection & metadata ───────────────────────────────────────────────────

describe("detectSide", () => {
  it("identifies a PS4 save by its 1-byte tz record", () => {
    expect(
      detectSide(
        parseSave(
          buildBigSave({ side: "ps4", names: "x", progressA: 1, progressB: 1, tailFill: 4 }),
        ),
      ),
    ).toBe("ps4");
  });
  it("identifies a Switch save by its 208-byte tz record", () => {
    expect(
      detectSide(
        parseSave(
          buildBigSave({ side: "switch", names: "x", progressA: 1, progressB: 1, tailFill: 4 }),
        ),
      ),
    ).toBe("switch");
  });
});

describe("extractPlayerName", () => {
  it("reads the first name slot", () => {
    const parsed = parseSave(
      buildBigSave({ side: "ps4", names: "Nate", progressA: 1, progressB: 1, tailFill: 4 }),
    );
    expect(extractPlayerName(parsed)).toBe("Nate");
  });
});

// ── Conversion ─────────────────────────────────────────────────────────────

describe("convertBigSave", () => {
  it("keeps the skeleton structure and transplants matching values", () => {
    const skel = buildBigSave({
      side: "ps4",
      names: "Old",
      progressA: 1,
      progressB: 2,
      tailFill: 16,
    });
    const donor = buildBigSave({
      side: "switch",
      names: "New",
      progressA: 42,
      progressB: 99,
      tailFill: 16,
    });
    const { output, stats } = convertBigSave(skel, donor);

    expect(output.length).toBe(skel.length); // PS4-native size kept
    const parsed = parseSave(output);
    expect(detectSide(parsed)).toBe("ps4"); // tz record stayed PS4-sized

    // Progress values transplanted where sizes matched.
    const recA = parsed.sections[0].records.find((r) => r.key === 0x12345678)!;
    expect(recordU32(parsed, recA.offset)).toBe(42);
    const recB = parsed.sections[1].records.find((r) => r.key === 0x87654321)!;
    expect(recordU32(parsed, recB.offset)).toBe(99);

    // Version-specific records kept skeleton values.
    const tz = parsed.sections[0].records.find((r) => r.key === KEY_TZ_TABLE)!;
    expect(tz.len).toBe(1);
    const pad = parsed.sections[1].records.find((r) => r.key === 0xc855d2ce)!;
    expect(pad.len).toBe(4);

    // Bulk tail copied wholesale from the donor.
    const tailStart = parsed.sections[2].offset;
    const donorParsed = parseSave(donor);
    expect(output.subarray(tailStart)).toEqual(donor.subarray(donorParsed.sections[2].offset));

    expect(stats.substituted).toBe(3); // player names + both progress values
    expect(stats.kept).toBe(2); // tz table + 8v4 padding record
  });

  it("rejects two saves from the same platform via buildConversion", () => {
    const a = buildBigSave({ side: "ps4", names: "x", progressA: 1, progressB: 1, tailFill: 4 });
    const b = buildBigSave({ side: "ps4", names: "y", progressA: 2, progressB: 2, tailFill: 4 });
    expect(() =>
      buildConversion({
        switchFiles: { userdata: a },
        ps4Files: { userdata: b },
        direction: "switch-to-ps4",
      }),
    ).toThrow(/both USERDATA00 files/i);
  });

  it("rejects donors whose bulk data is a different size", () => {
    const skel = buildBigSave({
      side: "ps4",
      names: "x",
      progressA: 1,
      progressB: 1,
      tailFill: 16,
    });
    const donor = buildBigSave({
      side: "switch",
      names: "y",
      progressA: 1,
      progressB: 1,
      tailFill: 32,
    });
    expect(() => convertBigSave(skel, donor)).toThrow(/bulk data is/);
  });
});

describe("convertHeadersave", () => {
  it("copies the donor wholesale when sizes match", () => {
    const a = buildSection(0x1001, IDENT_A, [{ key: 1, value: new Uint8Array(8) }]);
    const b = buildSection(0x1001, IDENT_A, [{ key: 1, value: new Uint8Array(8).fill(9) }]);
    expect(convertHeadersave(a, b)).toEqual(b);
  });

  it("returns null when sizes differ", () => {
    const a = buildSection(0x1001, IDENT_A, [{ key: 1, value: new Uint8Array(8) }]);
    const b = buildSection(0x1001, IDENT_A, [{ key: 1, value: new Uint8Array(16) }]);
    expect(convertHeadersave(a, b)).toBeNull();
  });
});

describe("buildConversion", () => {
  it("produces a full PS4 layout from a Switch donor", () => {
    const swUser = buildBigSave({
      side: "switch",
      names: "Nate",
      progressA: 11,
      progressB: 22,
      tailFill: 16,
    });
    const swAuto = buildBigSave({
      side: "switch",
      names: "Nate",
      progressA: 12,
      progressB: 23,
      tailFill: 16,
    });
    const ps4User = buildBigSave({
      side: "ps4",
      names: "nase",
      progressA: 1,
      progressB: 2,
      tailFill: 16,
    });
    const ps4Auto = buildBigSave({
      side: "ps4",
      names: "nase",
      progressA: 1,
      progressB: 2,
      tailFill: 16,
    });
    const swHead = buildSection(0x1001, IDENT_A, [{ key: 1, value: new Uint8Array(8) }]);
    const ps4Head = buildSection(0x1001, IDENT_A, [{ key: 1, value: new Uint8Array(8) }]);

    const result = buildConversion({
      switchFiles: { userdata: swUser, autosave: swAuto, headersave: swHead },
      ps4Files: { userdata: ps4User, autosave: ps4Auto, headersave: ps4Head },
      direction: "switch-to-ps4",
    });

    expect([...result.files.keys()]).toEqual([
      "USERDATAMOUNT/USERDATA00_data.bin",
      "USERDATAMOUNT/AUTOSAVE_data.bin",
      "USERDATAMOUNT/HEADERSAVE_data.bin",
    ]);
    for (const [name, data] of result.files) {
      if (name.endsWith("HEADERSAVE_data.bin")) {
        expect(data).toEqual(swHead); // wholesale from the donor
      } else {
        expect(data.length).toBe(ps4User.length); // PS4-native structure
        expect(detectSide(parseSave(data))).toBe("ps4");
      }
    }
    expect(result.log.join("\n")).toContain("USERDATA00: 3 value(s) transplanted");
  });

  it("works in the PS4 → Switch direction too", () => {
    const swUser = buildBigSave({
      side: "switch",
      names: "Nate",
      progressA: 11,
      progressB: 22,
      tailFill: 16,
    });
    const ps4User = buildBigSave({
      side: "ps4",
      names: "nase",
      progressA: 1,
      progressB: 2,
      tailFill: 16,
    });

    const result = buildConversion({
      switchFiles: { userdata: swUser },
      ps4Files: { userdata: ps4User },
      direction: "ps4-to-switch",
    });

    const out = result.files.get("USERDATA00/data.bin")!;
    expect(out.length).toBe(swUser.length); // Switch-native structure kept
    const parsed = parseSave(out);
    expect(detectSide(parsed)).toBe("switch");
    const rec = parsed.sections[0].records.find((r) => r.key === 0x12345678)!;
    expect(recordU32(parsed, rec.offset)).toBe(1); // PS4 value
  });
});

describe("buildSkeleton", () => {
  it("produces a parseable PS4 template", () => {
    const parsed = parseSave(buildSkeleton("ps4"));
    expect(parsed.sections.length).toBe(3);
    expect(detectSide(parsed)).toBe("ps4");
  });

  it("produces a parseable Switch template with a real tz record", () => {
    const parsed = parseSave(buildSkeleton("switch"));
    expect(detectSide(parsed)).toBe("switch");
    const tz = parsed.sections[0].records.find((r) => r.key === KEY_TZ_TABLE)!;
    expect(tz.len).toBe(208);
    const raw = parsed.data.subarray(tz.offset + 8, tz.offset + 8 + tz.len);
    expect(raw.some((b) => b !== 0)).toBe(true);
  });
});

describe("single-sided conversion", () => {
  it("converts a lone Switch save using the built-in PS4 template", () => {
    const swUser = buildBigSave({
      side: "switch",
      names: "Nate",
      progressA: 11,
      progressB: 22,
      tailFill: 0,
      tailSpan: TAIL_SIZE,
    });
    const result = buildConversion({
      switchFiles: { userdata: swUser },
      ps4Files: {},
      direction: "switch-to-ps4",
    });
    const out = result.files.get("USERDATAMOUNT/USERDATA00_data.bin")!;
    expect(detectSide(parseSave(out))).toBe("ps4");
    // bulk tail must come from the Switch donor
    const donor = parseSave(swUser);
    const outParsed = parseSave(out);
    expect(out.subarray(outParsed.sections[2].offset)).toEqual(
      swUser.subarray(donor.sections[2].offset),
    );
    expect(result.log.join("\n")).toContain("USERDATA00:");
  });

  it("converts a lone PS4 save using the built-in Switch template", () => {
    const ps4User = buildBigSave({
      side: "ps4",
      names: "nase",
      progressA: 1,
      progressB: 2,
      tailFill: 0,
      tailSpan: TAIL_SIZE,
    });
    const result = buildConversion({
      switchFiles: {},
      ps4Files: { userdata: ps4User },
      direction: "ps4-to-switch",
    });
    const out = result.files.get("USERDATA00/data.bin")!;
    expect(detectSide(parseSave(out))).toBe("switch");
  });
});

// ── File classification ────────────────────────────────────────────────────

function dropped(rel: string, size = 10): DroppedFile {
  return { file: new File([new Uint8Array(size)], rel.split("/").pop()!), relativePath: rel };
}

describe("file classification", () => {
  it("handles folder-per-file Switch exports", () => {
    const slots = classifySwitchFiles([
      dropped("save/AUTOSAVE/data.bin"),
      dropped("save/USERDATA00/data.bin"),
      dropped("save/HEADERSAVE/data.bin"),
      dropped("save/SYSTEM/data.bin"),
    ]);
    expect(slots.USERDATA00?.relativePath).toBe("save/USERDATA00/data.bin");
    expect(slots.AUTOSAVE?.relativePath).toBe("save/AUTOSAVE/data.bin");
    expect(slots.HEADERSAVE?.relativePath).toBe("save/HEADERSAVE/data.bin");
    expect(slots.SYSTEM?.relativePath).toBe("save/SYSTEM/data.bin");
  });

  it("handles flat Switch exports", () => {
    const slots = classifySwitchFiles([dropped("USERDATA00"), dropped("AUTOSAVE")]);
    expect(slots.USERDATA00?.relativePath).toBe("USERDATA00");
    expect(slots.AUTOSAVE?.relativePath).toBe("AUTOSAVE");
  });

  it("handles PS4 savedata dumps", () => {
    const slots = classifyPs4Files([
      dropped("CUSA17589/USERDATAMOUNT/USERDATA00_data.bin"),
      dropped("CUSA17589/USERDATAMOUNT/AUTOSAVE_data.bin"),
      dropped("CUSA17589/SYSTEMMOUNT/SYSTEM_data.bin"),
      dropped("CUSA17589/USERDATAMOUNT/sce_sys/param.sfo"),
    ]);
    expect(slots.USERDATA00?.relativePath).toBe("CUSA17589/USERDATAMOUNT/USERDATA00_data.bin");
    expect(slots.AUTOSAVE?.relativePath).toBe("CUSA17589/USERDATAMOUNT/AUTOSAVE_data.bin");
    expect(slots.SYSTEM?.relativePath).toBe("CUSA17589/SYSTEMMOUNT/SYSTEM_data.bin");
    expect(slots.HEADERSAVE).toBeUndefined();
  });
});
