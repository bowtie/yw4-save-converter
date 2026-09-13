import { useState, useEffect, useCallback } from "react";
import { SaveFolderDrop, type DroppedFile } from "./FileUploads";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Toaster, toast } from "@/components/ui/toast";
import {
  DownloadIcon,
  LoaderIcon,
  TriangleAlertIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  CircleAlertIcon,
} from "lucide-react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  buildConversion,
  detectSide,
  extractPlayerName,
  parseSave,
  type ConversionResult,
  type Side,
} from "./lib/converter";
import { classifyAll, type SaveSlotFiles, type SlotName } from "./lib/file-selection";

const SLOT_LABELS: Record<SlotName, string> = {
  USERDATA00: "Save slot",
  AUTOSAVE: "Autosave",
  HEADERSAVE: "Save header",
  SYSTEM: "System (ignored)",
};

interface SideInfo {
  slots: SaveSlotFiles;
  side: Side | "unknown";
  playerName: string | null;
}

const EMPTY_INFO = (): SideInfo => ({ slots: {}, side: "unknown", playerName: null });

async function inspectUserdata(
  file: File | undefined,
): Promise<{ side: Side | "unknown"; playerName: string | null }> {
  if (!file) return { side: "unknown", playerName: null };
  try {
    const parsed = parseSave(new Uint8Array(await file.arrayBuffer()));
    return { side: detectSide(parsed), playerName: extractPlayerName(parsed) };
  } catch {
    return { side: "unknown", playerName: null };
  }
}

function readmeFor(direction: "switch-to-ps4" | "ps4-to-switch"): string {
  if (direction === "switch-to-ps4") {
    return [
      "Yo-kai Watch 4++ save conversion (Switch -> PS4)",
      "",
      "Your Switch progress, rebuilt as PS4 saves:",
      "  USERDATAMOUNT/USERDATA00_data.bin",
      "  USERDATAMOUNT/AUTOSAVE_data.bin",
      "  USERDATAMOUNT/HEADERSAVE_data.bin",
      "",
      "1. Close the game.",
      "2. Back up your current save folder.",
      "3. Copy the USERDATAMOUNT folder over yours (replace files).",
      "4. Start the game.",
      "",
      "If anything looks wrong, restore the backup you made in step 2.",
    ].join("\n");
  }
  return [
    "Yo-kai Watch 4++ save conversion (PS4 -> Switch)",
    "",
    "Your PS4 progress, rebuilt as Switch saves:",
    "  USERDATA00/data.bin",
    "  AUTOSAVE/data.bin",
    "  HEADERSAVE/data.bin",
    "",
    "1. Close the game.",
    "2. Back up your current save folder.",
    "3. Copy each folder over yours (replace files).",
    "",
    "If anything looks wrong, restore the backup you made in step 2.",
  ].join("\n");
}

export default function App() {
  const [sw, setSw] = useState<SideInfo>(EMPTY_INFO());
  const [ps4, setPs4] = useState<SideInfo>(EMPTY_INFO());
  const [notes, setNotes] = useState<string[]>([]);
  const [hasFiles, setHasFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("yw4-save.zip");
  const [clearSignal, setClearSignal] = useState(0);

  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  const resetOutput = useCallback(() => {
    setResult(null);
    if (downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(null);
    }
  }, [downloadUrl]);

  const handleFiles = useCallback(
    async (files: DroppedFile[]) => {
      const { switchSlots, ps4Slots, notes: foundNotes } = classifyAll(files);
      setHasFiles(true);
      resetOutput();

      if (!switchSlots.USERDATA00 && !ps4Slots.USERDATA00) {
        setSw(EMPTY_INFO());
        setPs4(EMPTY_INFO());
        setNotes(foundNotes);
        toast.create({
          type: "error",
          title: "No Yo-kai Watch save files found",
          description: "It should contain files like USERDATA00/data.bin or USERDATA00_data.bin.",
        });
        return;
      }

      const [swInfo, ps4Info] = await Promise.all([
        inspectUserdata(switchSlots.USERDATA00?.file),
        inspectUserdata(ps4Slots.USERDATA00?.file),
      ]);
      setSw({ slots: switchSlots, ...swInfo });
      setPs4({ slots: ps4Slots, ...ps4Info });
      setNotes(foundNotes);
    },
    [resetOutput],
  );

  const handleClear = useCallback(() => {
    setSw(EMPTY_INFO());
    setPs4(EMPTY_INFO());
    setNotes([]);
    setHasFiles(false);
    resetOutput();
    setClearSignal((s) => s + 1);
  }, [resetOutput]);

  // Direction: both sides present -> detect; a single side converts to the
  // other platform using the built-in structure template.
  const hasSw = Boolean(sw.slots.USERDATA00);
  const hasPs4 = Boolean(ps4.slots.USERDATA00);
  let direction: "switch-to-ps4" | "ps4-to-switch" | null = null;
  let directionError: string | null = null;
  if (hasSw && hasPs4) {
    if (sw.side !== "unknown" && ps4.side !== "unknown") {
      if (sw.side === "switch" && ps4.side === "ps4") direction = "switch-to-ps4";
      else if (sw.side === "ps4" && ps4.side === "switch") direction = "ps4-to-switch";
      else directionError = "Both saves are from the same platform.";
    } else {
      direction = "switch-to-ps4"; // fall back to the folder layout
    }
  } else if (hasSw) {
    direction = "switch-to-ps4";
  } else if (hasPs4) {
    direction = "ps4-to-switch";
  }

  const canConvert =
    direction !== null &&
    directionError === null &&
    Boolean(sw.slots.USERDATA00 && ps4.slots.USERDATA00) &&
    !busy;

  const handleConvert = async () => {
    if (!direction) {
      toast.create({ type: "error", title: "Drop a save folder first." });
      return;
    }
    setBusy(true);
    try {
      const res = buildConversion({
        switchFiles: {
          userdata: sw.slots.USERDATA00
            ? new Uint8Array(await sw.slots.USERDATA00.file.arrayBuffer())
            : undefined,
          autosave: sw.slots.AUTOSAVE
            ? new Uint8Array(await sw.slots.AUTOSAVE.file.arrayBuffer())
            : undefined,
          headersave: sw.slots.HEADERSAVE
            ? new Uint8Array(await sw.slots.HEADERSAVE.file.arrayBuffer())
            : undefined,
        },
        ps4Files: {
          userdata: ps4.slots.USERDATA00
            ? new Uint8Array(await ps4.slots.USERDATA00.file.arrayBuffer())
            : undefined,
          autosave: ps4.slots.AUTOSAVE
            ? new Uint8Array(await ps4.slots.AUTOSAVE.file.arrayBuffer())
            : undefined,
          headersave: ps4.slots.HEADERSAVE
            ? new Uint8Array(await ps4.slots.HEADERSAVE.file.arrayBuffer())
            : undefined,
        },
        direction,
      });
      res.files.set("README.txt", new TextEncoder().encode(readmeFor(direction)));
      setResult(res);
      setFilename(direction === "switch-to-ps4" ? "ps4-save.zip" : "switch-save.zip");
      toast.create({ type: "success", title: "Converted! Download the ZIP below." });
    } catch (err) {
      toast.create({ type: "error", title: `Error: ${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const downloadZip = async () => {
    if (!result) return;
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (const [name, data] of result.files) zip.file(name, data);
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  };

  const sideBadge = (side: Side | "unknown") =>
    side === "switch" ? "Switch save" : side === "ps4" ? "PS4 save" : "Unrecognized";

  const slotList = (info: SideInfo) => {
    const names = (Object.keys(SLOT_LABELS) as SlotName[]).filter((n) => info.slots[n]);
    if (names.length === 0)
      return <p className="text-xs text-muted-foreground italic">no save files found</p>;
    return (
      <div className="flex flex-col gap-1">
        {names.map((name) => {
          const entry = info.slots[name]!;
          const ignored = name === "SYSTEM";
          return (
            <div key={name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {ignored ? (
                <CircleAlertIcon className="size-3.5 shrink-0" />
              ) : (
                <CircleCheckIcon className="size-3.5 shrink-0 text-green-500" />
              )}
              <span className="truncate">
                {SLOT_LABELS[name]}
                {info.playerName && !ignored ? ` · ${info.playerName}` : ""}
                {` · ${entry.relativePath.split("/").slice(-2).join("/")}`}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="mx-auto w-full max-w-lg px-6 py-10">
        {/* Header */}
        <header className="mb-6 flex items-center gap-4">
          <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 outline-1 outline-white/10 select-none">
            <img
              src="./mascot.png"
              alt="Yo-kai Watch 4++"
              width={92}
              height={92}
              draggable={false}
              className="max-w-none"
            />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
              Yo-kai Watch 4++ Save Converter
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Convert Yo-kai Watch 4++ saves between Nintendo Switch and PS4.
            </p>
          </div>
        </header>

        {/* Experimental warning */}
        <Alert variant="warning" className="mb-6">
          <TriangleAlertIcon />
          <AlertTitle>Heads up, this is experimental</AlertTitle>
          <AlertDescription>
            <span>Back up your saves before converting.</span>
          </AlertDescription>
        </Alert>

        {/* FAQ */}
        <div className="mb-6">
          <Accordion>
            <AccordionItem value="how">
              <AccordionTrigger className="py-3">How does it work?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground pb-3">
                Drop a save folder and hit convert. Switch or PS4, it detects the platform and
                rebuilds your progress in the other format. Everything runs in your browser, nothing
                gets uploaded anywhere.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="safety">
              <AccordionTrigger className="py-3">Is it safe?</AccordionTrigger>
              <AccordionContent className="text-muted-foreground pb-3">
                Back up your saves first. If a conversion can't be done safely, the tool refuses
                instead of creating a broken save.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* Converter */}
        <Card className="gap-0 rounded-xl py-0">
          <CardContent className="p-3 space-y-3">
            <SaveFolderDrop
              onFilesDropped={handleFiles}
              onClear={handleClear}
              clearSignal={clearSignal}
            />

            {hasFiles && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-1 gap-2 rounded-lg border bg-muted/30 p-2.5">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        Switch side
                      </Badge>
                      {sw.slots.USERDATA00 && (
                        <span className="text-xs text-muted-foreground">{sideBadge(sw.side)}</span>
                      )}
                    </div>
                    {slotList(sw)}
                  </div>
                  <div className="border-t pt-2">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs">
                        PS4 side
                      </Badge>
                      {ps4.slots.USERDATA00 && (
                        <span className="text-xs text-muted-foreground">{sideBadge(ps4.side)}</span>
                      )}
                    </div>
                    {slotList(ps4)}
                  </div>
                </div>

                {notes.length > 0 && (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {notes.map((n, i) => (
                      <p key={i}>{n}</p>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-center gap-2 text-muted-foreground">
                  <ArrowRightIcon className="size-4" />
                  {directionError ? (
                    <span className="text-xs text-destructive">{directionError}</span>
                  ) : direction ? (
                    <span className="text-xs">
                      {direction === "switch-to-ps4"
                        ? "Switch → PS4"
                        : "PS4 → Switch (experimental)"}
                    </span>
                  ) : (
                    <span className="text-xs">one side still missing</span>
                  )}
                </div>
              </div>
            )}

            <Button
              onClick={handleConvert}
              disabled={!canConvert}
              className="w-full h-10 rounded-lg text-sm"
            >
              {busy ? (
                <>
                  <LoaderIcon className="animate-spin" />
                  Converting...
                </>
              ) : (
                <>Convert</>
              )}
            </Button>

            {result && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full h-10 rounded-lg text-sm"
                  onClick={downloadZip}
                >
                  <DownloadIcon />
                  Download ZIP
                </Button>
                <div className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground space-y-1">
                  {result.log.map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Toaster />
    </div>
  );
}
