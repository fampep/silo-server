import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { FileVersion } from "@/api/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatFileSize } from "@/lib/mediaFormat";
import { StaleApiRequestContextError } from "@/api/client";
import { launchDirectDownload } from "@/api/v2/directDownloads";
import { buildQualitySummary, sortByResolution } from "@/pages/ItemDetail/components/VersionFlyout";
import { cn } from "@/lib/utils";

interface DownloadVersionPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: FileVersion[];
  title?: string;
  summaryBuilder?: (version: FileVersion) => string;
  selectionControls?: ReactNode;
}

export default function DownloadVersionPicker({
  open,
  onOpenChange,
  versions,
  title,
  summaryBuilder,
  selectionControls,
}: DownloadVersionPickerProps) {
  const sorted = sortByResolution(versions);
  const versionKey = sorted.map((version) => version.file_id).join(",");
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const selected =
    sorted.find((version) => version.file_id === selectedFileId) ??
    (sorted.length === 1 ? sorted[0] : undefined);

  const active = useRef<symbol | null>(null);
  useLayoutEffect(() => {
    active.current = null;
    setSelectedFileId(null);
    setDownloading(false);
    return () => {
      active.current = null;
    };
  }, [open, versionKey]);

  const handleDownload = async () => {
    if (active.current || !open || !selected) return;
    const attempt = Symbol();
    active.current = attempt;
    const isCurrent = () => active.current === attempt;
    setDownloading(true);
    try {
      await launchDirectDownload(selected.file_id, isCurrent);
      if (isCurrent()) onOpenChange(false);
    } catch (error) {
      if (isCurrent() && !(error instanceof StaleApiRequestContextError))
        toast.error("Download could not be started. Check access and try again.");
    } finally {
      if (isCurrent()) {
        active.current = null;
        setDownloading(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Download{title ? `: ${title}` : ""}</DialogTitle>
          <DialogDescription>
            Choose the original file you want. Format, quality, and size depend on the available
            files.
          </DialogDescription>
        </DialogHeader>

        {selectionControls}

        <div className="space-y-2" role="group" aria-label="Available download formats">
          {sorted.map((version) => {
            const quality =
              summaryBuilder?.(version) || buildQualitySummary(version) || "Original file";
            const size = formatFileSize(version.file_size);
            const container = version.container?.toUpperCase();
            const picked = selected?.file_id === version.file_id;
            return (
              <button
                key={version.file_id}
                type="button"
                aria-pressed={picked}
                onClick={() => setSelectedFileId(version.file_id)}
                disabled={downloading}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors disabled:opacity-50",
                  picked
                    ? "border-primary bg-primary/10 ring-primary/20 ring-1"
                    : "border-border/60 bg-accent/20 hover:bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full",
                    picked ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
                  )}
                >
                  {picked ? <Check className="size-4" /> : <Download className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block text-sm font-semibold">{quality}</span>
                  {(container || size) && (
                    <span className="text-muted-foreground block text-xs">
                      {[container, size].filter(Boolean).join(" | ")}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {sorted.length === 0 && (
            <p className="text-muted-foreground py-6 text-center text-sm">
              No downloadable files are available.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={downloading}>
            Cancel
          </Button>
          <Button onClick={handleDownload} disabled={!selected || downloading} className="gap-2">
            {downloading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Download selected file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
