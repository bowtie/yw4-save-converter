/** Identify Yo-kai Watch 4++ save files inside dropped folders. */

import { isAutosave, parseSave } from "./converter";

export interface DroppedFile {
  file: File;
  relativePath: string;
}

export type SlotName = "USERDATA00" | "AUTOSAVE" | "HEADERSAVE" | "SYSTEM";

export interface SaveSlotFiles {
  USERDATA00?: DroppedFile;
  AUTOSAVE?: DroppedFile;
  HEADERSAVE?: DroppedFile;
  SYSTEM?: DroppedFile;
}

const SLOT_NAMES = new Set(["USERDATA00", "AUTOSAVE", "HEADERSAVE", "SYSTEM"]);

/** Paths matching this are only used as a last resort (our own outputs/backups). */
const LOW_PRIORITY = /(^|\/)(backup|converted|dist|old|\.zcode)(\/|$)/i;

function normalize(name: string): string {
  return name.toUpperCase();
}

function pickCandidate(candidates: DroppedFile[]): DroppedFile | undefined {
  if (candidates.length === 0) return undefined;
  const sorted = [...candidates].sort((a, b) => {
    const pa = LOW_PRIORITY.test(a.relativePath) ? 1 : 0;
    const pb = LOW_PRIORITY.test(b.relativePath) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return a.relativePath.split("/").length - b.relativePath.split("/").length;
  });
  return sorted[0];
}

/**
 * Switch-side layouts:
 *  - one folder per save file: `USERDATA00/data.bin`
 *  - flat exports where the save files are named directly: `USERDATA00`
 */
export function classifySwitchFiles(files: readonly DroppedFile[]): SaveSlotFiles {
  const found = new Map<SlotName, DroppedFile[]>();
  for (const f of files) {
    const parts = f.relativePath.split("/");
    const base = normalize(parts[parts.length - 1]);
    let slot: SlotName | null = null;
    if (parts.length >= 2 && base === "DATA.BIN") {
      const parent = normalize(parts[parts.length - 2]);
      if (SLOT_NAMES.has(parent)) slot = parent as SlotName;
    } else if (SLOT_NAMES.has(base)) {
      slot = base as SlotName;
    }
    if (slot) {
      const list = found.get(slot) ?? [];
      list.push(f);
      found.set(slot, list);
    }
  }
  const out: SaveSlotFiles = {};
  for (const [slot, list] of found) {
    const picked = pickCandidate(list);
    if (picked) out[slot] = picked;
  }
  return out;
}

/** PS4-side layout: `*_data.bin` files inside a savedata folder. */
export function classifyPs4Files(files: readonly DroppedFile[]): SaveSlotFiles {
  const found = new Map<SlotName, DroppedFile[]>();
  for (const f of files) {
    const parts = f.relativePath.split("/");
    const base = normalize(parts[parts.length - 1]);
    const match = base.match(/^(USERDATA00|AUTOSAVE|HEADERSAVE|SYSTEM)_DATA\.BIN$/);
    if (match) {
      const slot = match[1] as SlotName;
      const list = found.get(slot) ?? [];
      list.push(f);
      found.set(slot, list);
    }
  }
  const out: SaveSlotFiles = {};
  for (const [slot, list] of found) {
    const picked = pickCandidate(list);
    if (picked) out[slot] = picked;
  }
  return out;
}

export interface Classification {
  switchSlots: SaveSlotFiles;
  ps4Slots: SaveSlotFiles;
  /** Human notes about ambiguous matches. */
  notes: string[];
}

/** One-pass classification of a single dropped folder tree (both platforms). */
export function classifyAll(files: readonly DroppedFile[]): Classification {
  const switchSlots = classifySwitchFiles(files);
  const ps4Slots = classifyPs4Files(files);
  const notes: string[] = [];

  // Warn when several distinct candidates existed for a slot.
  const warnAmbiguous = (slots: SaveSlotFiles, kind: "switch" | "ps4", label: string) => {
    for (const slot of Object.keys(slots) as SlotName[]) {
      const picked = slots[slot]!;
      const alternatives = files.filter((f) => {
        if (f.relativePath === picked.relativePath) return false;
        return sameSlotBasename(kind, f, slot);
      });
      const real = alternatives.filter((f) => !LOW_PRIORITY.test(f.relativePath));
      if (real.length > 0) {
        notes.push(`Multiple ${slot} files found (${label} side); using ${picked.relativePath}.`);
      }
    }
  };
  warnAmbiguous(switchSlots, "switch", "Switch");
  warnAmbiguous(ps4Slots, "ps4", "PS4");

  return { switchSlots, ps4Slots, notes };
}

function sameSlotBasename(kind: string, f: DroppedFile, slot: SlotName): boolean {
  const base = normalize(f.relativePath.split("/").pop() ?? "");
  if (kind === "ps4") return base === `${slot}_DATA.BIN`;
  if (base === `${slot}.BIN` || base === slot) return true;
  const parts = f.relativePath.split("/");
  return parts.length >= 2 && base === "DATA.BIN" && normalize(parts[parts.length - 2]) === slot;
}

export function hasAnySlots(slots: SaveSlotFiles): boolean {
  return Boolean(slots.USERDATA00 || slots.AUTOSAVE || slots.HEADERSAVE || slots.SYSTEM);
}

/**
 * Last-resort classification for bare `data.bin` files dropped without their
 * slot folder (a lone `data.bin` carries no slot name in its path). The save
 * structure gives it away: big saves (USERDATA00 / AUTOSAVE) hold 3+ sections
 * while HEADERSAVE holds exactly one, and the section-0 manual-save flag
 * (key 0xff73995b) separates USERDATA00 (1) from AUTOSAVE (0). Only the
 * `data.bin` name exists on the Switch side, so these are treated as Switch
 * files. Without the flag a big save is assumed to be USERDATA00.
 */
export async function sniffDataBinSlots(files: readonly DroppedFile[]): Promise<SaveSlotFiles> {
  const out: SaveSlotFiles = {};
  const bigSaves: DroppedFile[] = [];
  let headersave: DroppedFile | undefined;
  for (const f of files) {
    const base = normalize(f.relativePath.split("/").pop() ?? "");
    if (base !== "DATA.BIN") continue;
    let parsed;
    try {
      parsed = parseSave(new Uint8Array(await f.file.arrayBuffer()));
    } catch {
      continue; // not a Yo-kai Watch save
    }
    if (parsed.sections.length >= 3) {
      if (isAutosave(parsed) === true) {
        if (!out.AUTOSAVE) out.AUTOSAVE = f;
      } else {
        bigSaves.push(f);
      }
    } else if (parsed.sections.length === 1 && !headersave) {
      headersave = f;
    }
  }
  const namedUserdata = bigSaves.find((f) => /USERDATA00/i.test(f.relativePath));
  if (namedUserdata ?? bigSaves[0]) out.USERDATA00 = namedUserdata ?? bigSaves[0];
  if (headersave) out.HEADERSAVE = headersave;
  return out;
}
