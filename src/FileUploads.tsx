import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  FileUpload,
  FileUploadDropzone,
  FileUploadDropzoneIcon,
  FileUploadTitle,
  FileUploadDescription,
  useFileUpload,
} from "@/components/ui/file-upload";
import { X } from "lucide-react";
import type { DroppedFile } from "./lib/file-selection";

export type { DroppedFile };

interface SaveFolderDropProps {
  onFilesDropped: (files: DroppedFile[]) => void;
  onClear: () => void;
  clearSignal: number;
}

/**
 * A single folder dropzone. Users can drop a parent folder containing any
 * number of save folders, or drag save folders in directly. What was found
 * is auto-detected from the files themselves.
 *
 * Drag-and-drop needs special handling: browsers only populate
 * `webkitRelativePath` for the click-to-browse folder input, never for
 * dropped files. Without the folder path, Switch saves (USERDATA00/data.bin)
 * can't be identified, so dropped directories are traversed manually with
 * the entries API.
 */

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(success: (file: File) => void, failure?: (error: unknown) => void): void;
  createReader(): {
    readEntries(
      success: (entries: FileSystemEntryLike[]) => void,
      failure?: (error: unknown) => void,
    ): void;
  };
}

// readEntries returns at most 100 entries per call; loop until it comes back empty.
async function collectEntry(
  entry: FileSystemEntryLike,
  dir: string,
  out: DroppedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    out.push({ file, relativePath: dir + entry.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const children: FileSystemEntryLike[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      children.push(...batch);
    }
    for (const child of children) await collectEntry(child, `${dir}${entry.name}/`, out);
  }
}

export function SaveFolderDrop(props: SaveFolderDropProps) {
  const clearRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (props.clearSignal > 0) clearRef.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.clearSignal]);

  const handleFileChange = useCallback(
    (details: { acceptedFiles: File[] }) => {
      const files: DroppedFile[] = details.acceptedFiles.map((file) => ({
        file,
        relativePath:
          (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }));
      if (files.length > 0) props.onFilesDropped(files);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [props.onFilesDropped],
  );

  // Intercept the drop before the file-upload library sees it: rebuild the
  // folder structure it would otherwise flatten away.
  const handleDropCapture = useCallback(
    async (event: React.DragEvent) => {
      const items = Array.from(event.dataTransfer?.items ?? []);
      const entries = items
        .map((item) =>
          (
            item as unknown as { webkitGetAsEntry?: () => FileSystemEntryLike | null }
          ).webkitGetAsEntry?.(),
        )
        .filter((entry): entry is FileSystemEntryLike => entry !== null && entry !== undefined);
      if (entries.length === 0) return; // plain files: let the library handle it
      event.preventDefault();
      event.stopPropagation();
      const files: DroppedFile[] = [];
      try {
        for (const entry of entries) await collectEntry(entry, "", files);
      } catch {
        return;
      }
      if (files.length > 0) props.onFilesDropped(files);
    },
    [props.onFilesDropped],
  );

  return (
    <FileUpload directory maxFiles={8192} onFileChange={handleFileChange} className="w-full">
      <ClearWrapper onClear={props.onClear} clearRef={clearRef}>
        <FileUploadDropzone onDropCapture={handleDropCapture}>
          <FileUploadDropzoneIcon />
          <FileUploadTitle>Drop your saves</FileUploadTitle>
          <FileUploadDescription>
            Switch or PS4, one folder is enough. It detects the platform and converts to the other.
          </FileUploadDescription>
        </FileUploadDropzone>
        <div className="flex justify-center -mt-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => clearRef.current?.()}
          >
            <X className="h-3 w-3" /> Clear
          </Button>
        </div>
      </ClearWrapper>
    </FileUpload>
  );
}

function ClearWrapper({
  children,
  onClear,
  clearRef,
}: {
  children: React.ReactNode;
  onClear: () => void;
  clearRef: React.MutableRefObject<(() => void) | null>;
}) {
  const fileUpload = useFileUpload();

  const clear = useCallback(() => {
    fileUpload.clearFiles();
    onClear();
  }, [fileUpload, onClear]);

  useEffect(() => {
    clearRef.current = clear;
  }, [clear, clearRef]);

  return <>{children}</>;
}
