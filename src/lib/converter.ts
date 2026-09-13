/**
 * Yo-kai Watch 4++ save conversion (Nintendo Switch ↔ PS4).
 *
 * Save file layout (identical on both platforms):
 *
 *   A save file is a chain of sections. Each section:
 *     +0x00  ee ff          magic
 *     +0x02  u16            section type (0x1001, 0x1002, ...)
 *     +0x04  u32            index size = offset of this section's end marker
 *     +0x08  u32            section ident (0x00bda133, 0x84f7afc9, 0x5c9ebb5e, ...)
 *     +0x0c  u32            0x01000000 (bytes 00 00 00 01)
 *     +0x10  records...     [u32 key][u16 len][u16 flags][len bytes value]
 *     marker [u32 ident][u16 0][u16 0x0200]
 *     tail   ff ef 00 00
 *
 *   The next section starts right after the tail. The last section's tail
 *   ends the file. Big saves (USERDATA00 / AUTOSAVE) contain 4 sections;
 *   HEADERSAVE and SYSTEM contain a single section.
 *
 * Conversion strategy (validated in-game):
 *   - The destination-platform file is the "skeleton": sections 0 and 1 are
 *     rebuilt from it record-by-record so the output is byte-structure
 *     identical to what that platform's game writes.
 *   - Donor values replace skeleton values whenever key + length + flags all
 *     match. Version-specific records whose size differs (e.g. the Switch
 *     timezone/DST table, key 0x725ea090) keep the skeleton's value.
 *   - Sections 2..n carry the bulk of the progress data and are byte-aligned
 *     between platforms; they are copied wholesale from the donor.
 *   - HEADERSAVE is byte-aligned across platforms; when both sides are
 *     provided and their sizes match it is copied wholesale from the donor.
 *     SYSTEM is console-specific and never converted.
 */

export const SECTION_MAGIC0 = 0xee;
export const SECTION_MAGIC1 = 0xff;

/** Switch-only timezone/DST history record (208 bytes on Switch, 1 on PS4). */
export const KEY_TZ_TABLE = 0x725ea090;
/** Player name list: 36-byte UTF-8 slots. */
export const KEY_PLAYER_NAMES = 0x3c823935;

export const NAME_SLOT_SIZE = 36;

/** Minimum number of sections a big save (USERDATA00 / AUTOSAVE) must have. */
const MIN_BIG_SAVE_SECTIONS = 3;
/** How many leading sections get record-level splicing (the rest is copied). */
const SPLICE_SECTIONS = 2;

export type Side = "switch" | "ps4";

export interface Yw4Record {
  key: number;
  len: number;
  flags: number;
  /** Absolute offset of the record header in the file. */
  offset: number;
}

export interface Yw4Section {
  /** Absolute offset of the section header. */
  offset: number;
  type: number;
  idxSize: number;
  ident: number;
  records: Yw4Record[];
}

export interface ParsedSave {
  data: Uint8Array;
  sections: Yw4Section[];
}

export interface ConvertStats {
  substituted: number;
  kept: number;
  tailBytes: number;
}

export interface ConversionResult {
  /** Zip entry name -> bytes. */
  files: Map<string, Uint8Array>;
  log: string[];
}

// ── Parsing ────────────────────────────────────────────────────────────────

export function parseSave(data: Uint8Array): ParsedSave {
  if (data.length < 16) throw new Error("File is too small to be a Yo-kai Watch save.");
  if (data[0] !== SECTION_MAGIC0 || data[1] !== SECTION_MAGIC1) {
    throw new Error("Not a Yo-kai Watch 4++ save (missing `ee ff` magic).");
  }

  const sections: Yw4Section[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 0;

  while (off + 16 <= data.length) {
    if (data[off] !== SECTION_MAGIC0 || data[off + 1] !== SECTION_MAGIC1) break;
    const type = view.getUint16(off + 2, true);
    const idxSize = view.getUint32(off + 4, true);
    const ident = view.getUint32(off + 8, true);
    const recordsEnd = off + idxSize;
    if (recordsEnd + 12 > data.length) {
      throw new Error("Save file is truncated (section claims more data than the file holds).");
    }

    const records: Yw4Record[] = [];
    let roff = off + 16;
    while (roff + 8 <= recordsEnd) {
      const key = view.getUint32(roff, true);
      const len = view.getUint16(roff + 4, true);
      const flags = view.getUint16(roff + 6, true);
      if (roff + 8 + len > recordsEnd) break; // malformed tail; stop scanning
      records.push({ key, len, flags, offset: roff });
      roff += 8 + len;
    }

    sections.push({ offset: off, type, idxSize, ident, records });
    off = recordsEnd + 12; // end marker (8) + ff ef 00 00 (4)
  }

  if (sections.length === 0) {
    throw new Error("No valid sections found in save file.");
  }
  return { data, sections };
}

function findRecord(parsed: ParsedSave, sectionIndex: number, key: number): Yw4Record | undefined {
  return parsed.sections[sectionIndex]?.records.find((r) => r.key === key);
}

export function readRecord(parsed: ParsedSave, record: Yw4Record): Uint8Array {
  return parsed.data.subarray(record.offset + 8, record.offset + 8 + record.len);
}

/** Detect which platform a big save (USERDATA00 / AUTOSAVE) came from. */
export function detectSide(parsed: ParsedSave): Side | "unknown" {
  const tz = findRecord(parsed, 0, KEY_TZ_TABLE);
  if (!tz) return "unknown";
  if (tz.len === 1) return "ps4";
  if (tz.len > 4) return "switch";
  return "unknown";
}

/** First player name (36-byte UTF-8 slot) from the names record. */
export function extractPlayerName(parsed: ParsedSave): string | null {
  const rec = findRecord(parsed, 0, KEY_PLAYER_NAMES);
  if (!rec || rec.len < NAME_SLOT_SIZE) return null;
  const slot = readRecord(parsed, rec).subarray(0, NAME_SLOT_SIZE);
  const end = slot.findIndex((b) => b === 0);
  const name = new TextDecoder().decode(end === -1 ? slot : slot.subarray(0, end));
  return name.length > 0 ? name : null;
}

// ── Conversion ─────────────────────────────────────────────────────────────

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

/**
 * Rebuild sections 0..SPLICE_SECTIONS-1 from the skeleton, substituting donor
 * values where key/len/flags match; copy everything from section
 * SPLICE_SECTIONS onward wholesale from the donor.
 */
export function convertBigSave(
  skeleton: Uint8Array,
  donor: Uint8Array,
): { output: Uint8Array; stats: ConvertStats } {
  const skel = parseSave(skeleton);
  const don = parseSave(donor);

  if (skel.sections.length < MIN_BIG_SAVE_SECTIONS) {
    throw new Error(
      `Skeleton save has only ${skel.sections.length} section(s); expected at least ${MIN_BIG_SAVE_SECTIONS}.`,
    );
  }
  if (don.sections.length < MIN_BIG_SAVE_SECTIONS) {
    throw new Error(
      `Donor save has only ${don.sections.length} section(s); expected at least ${MIN_BIG_SAVE_SECTIONS}.`,
    );
  }

  for (let i = 0; i < SPLICE_SECTIONS; i++) {
    if (
      skel.sections[i].type !== don.sections[i].type ||
      skel.sections[i].ident !== don.sections[i].ident
    ) {
      throw new Error(
        `Section ${i} of the two saves does not match (type/ident differ). Are both files from Yo-kai Watch 4++?`,
      );
    }
  }

  const stats: ConvertStats = { substituted: 0, kept: 0, tailBytes: 0 };
  const chunks: Uint8Array[] = [];

  for (let i = 0; i < SPLICE_SECTIONS; i++) {
    const sec = skel.sections[i];
    const donorByKey = new Map<number, Yw4Record>();
    for (const r of don.sections[i].records) donorByKey.set(r.key, r);

    chunks.push(skel.data.subarray(sec.offset, sec.offset + 16)); // section header
    for (const rec of sec.records) {
      const header = skel.data.subarray(rec.offset, rec.offset + 8);
      let value = skel.data.subarray(rec.offset + 8, rec.offset + 8 + rec.len);
      const dRec = donorByKey.get(rec.key);
      if (dRec && dRec.len === rec.len && dRec.flags === rec.flags) {
        const dValue = don.data.subarray(dRec.offset + 8, dRec.offset + 8 + dRec.len);
        if (!bytesEqual(dValue, value)) {
          value = dValue;
          stats.substituted++;
        }
      } else {
        // No donor match or version-specific size (e.g. the Switch timezone
        // table): the skeleton's own value is kept.
        stats.kept++;
      }
      chunks.push(header, value);
    }
    // end marker + ff ef 00 00
    chunks.push(skel.data.subarray(sec.offset + sec.idxSize, sec.offset + sec.idxSize + 12));
  }

  // Wholesale tail: everything from skeleton section 2 to EOF must be the
  // same length on both platforms (byte-aligned bulk progress data).
  const skelTail = skel.data.length - skel.sections[SPLICE_SECTIONS].offset;
  const donTail = don.data.length - don.sections[SPLICE_SECTIONS].offset;
  if (skelTail !== donTail) {
    throw new Error(
      `Save versions differ too much: bulk data is ${skelTail} bytes on the skeleton platform but ` +
        `${donTail} bytes on the donor platform. This converter only supports matching game versions.`,
    );
  }
  stats.tailBytes = skelTail;
  chunks.push(don.data.subarray(don.sections[SPLICE_SECTIONS].offset));

  const output = concat(chunks);
  if (output.length !== skel.data.length) {
    throw new Error("Internal error: converted output size does not match the skeleton size.");
  }
  return { output, stats };
}

/**
 * HEADERSAVE conversion: byte-aligned across platforms, so the donor's file
 * is used wholesale when sizes match. Returns null when it must be skipped.
 */
export function convertHeadersave(skeleton: Uint8Array, donor: Uint8Array): Uint8Array | null {
  const skel = parseSave(skeleton);
  const don = parseSave(donor);
  if (
    skel.data.length !== don.data.length ||
    skel.sections[0].idxSize !== don.sections[0].idxSize
  ) {
    return null;
  }
  return don.data;
}

// ── Built-in save templates ────────────────────────────────────────────────
// Only the record layout matters: every record that matches the donor is
// overwritten with the donor's values, so the templates ship zero-filled.
// Derived from the final Switch 2.2.0 / PS4 1.50 saves.

import {
  IDENT_BIG,
  PS4_SECTION_A,
  PS4_SECTION_B,
  SECTION_A_TYPE,
  SECTION_B_TYPE,
  SECTION_C_TYPE,
  IDENT_C,
  SWITCH_SECTION_A,
  SWITCH_SECTION_B,
  SWITCH_TZ_BASE64,
  TAIL_SIZE,
  type SkeletonRow,
} from "./skeleton-data";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildSectionFromRows(
  type: number,
  ident: number,
  rows: SkeletonRow[],
  tz: Uint8Array | null,
): Uint8Array {
  const bodyLen = rows.reduce((n, r) => n + 8 + r.l, 0);
  const s = new Uint8Array(16 + bodyLen + 12);
  const v = new DataView(s.buffer);
  s[0] = SECTION_MAGIC0;
  s[1] = SECTION_MAGIC1;
  v.setUint16(2, type, true);
  v.setUint32(4, 16 + bodyLen, true); // idxSize = offset of the end marker
  v.setUint32(8, ident, true);
  v.setUint32(12, 0x01000000, true);
  let off = 16;
  for (const r of rows) {
    v.setUint32(off, r.k, true);
    v.setUint16(off + 4, r.l, true);
    v.setUint16(off + 6, r.f, true);
    if (tz && r.k === KEY_TZ_TABLE) s.set(tz, off + 8);
    off += 8 + r.l;
  }
  v.setUint32(off, ident, true); // end marker
  v.setUint16(off + 4, 0, true);
  v.setUint16(off + 6, 0x0200, true);
  s[off + 8] = 0xff;
  s[off + 9] = 0xef;
  return s;
}

/** Synthesize a destination-platform save structure for one-sided drops. */
export function buildSkeleton(side: Side): Uint8Array {
  const rowsA = side === "ps4" ? PS4_SECTION_A : SWITCH_SECTION_A;
  const rowsB = side === "ps4" ? PS4_SECTION_B : SWITCH_SECTION_B;
  const tz = side === "switch" ? base64ToBytes(SWITCH_TZ_BASE64) : null;
  const a = buildSectionFromRows(SECTION_A_TYPE, IDENT_BIG, rowsA, tz);
  const b = buildSectionFromRows(SECTION_B_TYPE, IDENT_BIG, rowsB, null);
  // A valid but empty section marks the start of the bulk-data region so the
  // converter's tail-size check sees the same layout as a real save.
  const emptyC = new Uint8Array(28);
  const cv = new DataView(emptyC.buffer);
  emptyC[0] = SECTION_MAGIC0;
  emptyC[1] = SECTION_MAGIC1;
  cv.setUint16(2, SECTION_C_TYPE, true);
  cv.setUint32(4, 16, true);
  cv.setUint32(8, IDENT_C, true);
  cv.setUint32(12, 0x01000000, true);
  cv.setUint32(16, IDENT_C, true);
  cv.setUint16(20, 0, true);
  cv.setUint16(22, 0x0200, true);
  emptyC[24] = 0xff;
  emptyC[25] = 0xef;
  const filler = new Uint8Array(TAIL_SIZE - emptyC.length);
  return concat([a, b, emptyC, filler]);
}

function isSaneHeadersave(data: Uint8Array): boolean {
  try {
    const parsed = parseSave(data);
    return parsed.sections.length === 1 && parsed.sections[0].idxSize === data.length - 12;
  } catch {
    return false;
  }
}

export interface BuildConversionInput {
  switchFiles: SaveSlotSet;
  ps4Files: SaveSlotSet;
  direction: "switch-to-ps4" | "ps4-to-switch";
}

export interface SaveSlotSet {
  userdata?: Uint8Array;
  autosave?: Uint8Array;
  headersave?: Uint8Array;
}

/** Build every output file for a conversion. Throws on invalid input.
 *  Either side may be missing: a built-in structure template stands in for it
 *  and the one save that was provided donates all progress values. */
export function buildConversion(input: BuildConversionInput): ConversionResult {
  const { switchFiles, ps4Files, direction } = input;
  const toPs4 = direction === "switch-to-ps4";

  const templateSide: Side = toPs4 ? "ps4" : "switch";
  const skelProvided = toPs4 ? ps4Files.userdata : switchFiles.userdata;
  const skelUser = skelProvided ?? buildSkeleton(templateSide);
  const skelIsTemplate = !skelProvided;
  const donUser = toPs4 ? switchFiles.userdata : ps4Files.userdata;
  if (!donUser) {
    throw new Error(
      `Missing the ${toPs4 ? "Switch" : "PS4"} USERDATA00 save. Drop at least one save to convert.`,
    );
  }

  // Sanity: when both sides are real files they must be different platforms.
  if (!skelIsTemplate) {
    const skelSide = detectSide(parseSave(skelUser));
    const donSide = detectSide(parseSave(donUser));
    if (skelSide !== "unknown" && donSide !== "unknown" && skelSide === donSide) {
      throw new Error(
        `Both USERDATA00 files look like ${skelSide.toUpperCase()} saves. Drop one save folder per platform.`,
      );
    }
  }

  const log: string[] = [];
  const files = new Map<string, Uint8Array>();
  const layout = toPs4 ? ps4Layout : switchLayout;

  const user = convertBigSave(skelUser, donUser);
  log.push(
    `USERDATA00: ${user.stats.substituted} value(s) transplanted, ` +
      `${(user.stats.tailBytes / 1024 / 1024).toFixed(2)} MB of progress data copied.`,
  );
  files.set(layout.userdata, user.output);

  // AUTOSAVE: same skeleton family. Prefer real skeletons when provided and
  // fall back to the donor's USERDATA00 when no autosave file was dropped.
  const skelAuto = toPs4
    ? (ps4Files.autosave ?? ps4Files.userdata ?? buildSkeleton("ps4"))
    : (switchFiles.autosave ?? switchFiles.userdata ?? buildSkeleton("switch"));
  const donAuto = toPs4 ? (switchFiles.autosave ?? donUser) : (ps4Files.autosave ?? donUser);
  const auto = convertBigSave(skelAuto, donAuto);
  log.push(
    `AUTOSAVE: ${auto.stats.substituted} value(s) transplanted, ` +
      `${(auto.stats.tailBytes / 1024 / 1024).toFixed(2)} MB of progress data copied.`,
  );
  files.set(layout.autosave, auto.output);

  // HEADERSAVE: wholesale copy from the donor (byte-aligned across platforms).
  const skelHead = toPs4 ? ps4Files.headersave : switchFiles.headersave;
  const donHead = toPs4 ? switchFiles.headersave : ps4Files.headersave;
  if (donHead) {
    let head: Uint8Array | null;
    if (skelHead) {
      head = convertHeadersave(skelHead, donHead);
    } else {
      // One-sided drop: accept the donor's headersave if it looks well-formed.
      head = isSaneHeadersave(donHead) ? donHead : null;
    }
    if (head) {
      files.set(layout.headersave, head);
      log.push(
        "HEADERSAVE: copied from the donor so the save list shows the transplanted progress.",
      );
    } else {
      log.push("HEADERSAVE: skipped (unexpected format). The save list may show stale info.");
    }
  } else {
    log.push("HEADERSAVE: skipped (not provided). The save list may show stale info.");
  }

  return { files, log };
}

const ps4Layout = {
  userdata: "USERDATAMOUNT/USERDATA00_data.bin",
  autosave: "USERDATAMOUNT/AUTOSAVE_data.bin",
  headersave: "USERDATAMOUNT/HEADERSAVE_data.bin",
};

const switchLayout = {
  userdata: "USERDATA00/data.bin",
  autosave: "AUTOSAVE/data.bin",
  headersave: "HEADERSAVE/data.bin",
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
