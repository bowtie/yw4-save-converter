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
 */
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

  return (
    <FileUpload directory maxFiles={8192} onFileChange={handleFileChange} className="w-full">
      <ClearWrapper onClear={props.onClear} clearRef={clearRef}>
        <FileUploadDropzone>
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
