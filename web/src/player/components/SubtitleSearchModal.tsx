import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import type { PlayerConfig } from "../context/PlayerConfigContext";
import { playerV2 } from "../player-v2";
import type { SubtitleLanguageDetection, SubtitleResult } from "@/api/types";
import { SubtitleUploadForm } from "@/components/subtitles/SubtitleUploadForm";
import { LANGUAGES, getLanguageName } from "../utils/languageNames";
import { canonicalLanguageWireValue } from "@/lib/languageNames";
import type { PlayerSubtitleInfo } from "../types";
import type { StoredSubtitle } from "../utils/subtitleSync";
import { toast } from "sonner";
import { PlayerFetchError } from "../player-fetch";
import {
  buildSubtitleTranslateRequest,
  translationSourceForRequest,
} from "./subtitleTranslateRequest";
import { sourceLabel } from "./SubtitleTranslateModal";

interface SubtitleSearchModalProps {
  mediaFileId: number;
  playerConfig: PlayerConfig;
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called with the stored subtitle a download or upload created, so the
   * player can show its automatic sync while it runs.
   */
  onSubtitleDownloaded: (subtitle?: StoredSubtitle) => void;
  /** False hides the online-search section; manual upload stays available. */
  onlineSearchEnabled?: boolean;
  /** Server can translate a text track. The search list then offers a translation when the language is not already on the file. */
  translationEnabled?: boolean;
  tracks?: PlayerSubtitleInfo[];
  onSubtitleJobAccepted?: (jobId: string, resultSubtitleId?: string) => void;
  sessionId?: string;
  getStartPosition?: () => number;
}

interface ProviderInfo {
  abbr: string;
  color: string;
}

const providerInfo: Record<string, ProviderInfo> = {
  opensubtitles: { abbr: "OS", color: "#eab308" },
  subdl: { abbr: "SDL", color: "#3b82f6" },
  subsource: { abbr: "SS", color: "#ef4444" },
  translate: { abbr: "TR", color: "#a78bfa" },
  upload: { abbr: "UP", color: "#a855f7" },
};

function scoreColor(score: number): string {
  if (score >= 70) return "#22c55e";
  if (score >= 40) return "#eab308";
  return "#ef4444";
}

export function SubtitleSearchModal({
  mediaFileId,
  playerConfig,
  isOpen,
  onClose,
  onSubtitleDownloaded,
  onlineSearchEnabled = true,
  translationEnabled = false,
  tracks = [],
  onSubtitleJobAccepted,
  sessionId,
  getStartPosition,
}: SubtitleSearchModalProps) {
  const [selectedLang, setSelectedLang] = useState("en");
  const [results, setResults] = useState<SubtitleResult[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchedLang, setSearchedLang] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLSelectElement>(null);
  const downloadGeneration = useRef(0);
  const uploadedSubtitle = useRef<StoredSubtitle | undefined>(undefined);
  useEffect(() => {
    downloadGeneration.current++;
    setDownloading(null);
    setSearchedLang(null);
    return () => {
      downloadGeneration.current++;
    };
  }, [playerConfig, mediaFileId, isOpen]);

  const handleClose = useCallback(() => {
    previousActiveElementRef.current?.focus();
    onClose();
  }, [onClose]);

  // Focus the search input on open and save the trigger element.
  useEffect(() => {
    if (!isOpen) return;
    previousActiveElementRef.current = document.activeElement as HTMLElement;
    // Delay to allow the modal to render before focusing.
    const timer = setTimeout(() => {
      // Without online search there is no search input; keep focus in the modal.
      (searchInputRef.current ?? modalRef.current?.querySelector<HTMLElement>("button"))?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // The provider probe can resolve after the modal opened. If it hides online
  // search, the focused language select unmounts; keep focus inside the modal.
  useEffect(() => {
    if (!isOpen || onlineSearchEnabled) return;
    const modal = modalRef.current;
    if (modal && !modal.contains(document.activeElement)) {
      modal.querySelector<HTMLElement>("button")?.focus();
    }
  }, [isOpen, onlineSearchEnabled]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleClose]);

  // Focus trap.
  const handleFocusTrap = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const modal = modalRef.current;
    if (!modal) return;

    const focusable = modal.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first && last) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last && first) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  const handleSearch = useCallback(async () => {
    setSearching(true);
    setError(null);
    setResults([]);
    setWarnings([]);
    setSearchedLang(selectedLang);

    try {
      const response = await playerV2(playerConfig, "POST /api/v2/subtitles/search", {
        body: {
          media_file_id: String(mediaFileId),
          languages: [canonicalLanguageWireValue(selectedLang) ?? selectedLang],
        },
      });
      setResults(response.results ?? []);
      setWarnings(response.warnings ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [playerConfig, mediaFileId, selectedLang]);

  const handleUpload = useCallback(
    async (input: {
      mediaFileId: number;
      file: File;
      language?: string;
      languageOverride?: boolean;
      hearingImpaired: boolean;
    }) => {
      const token = playerConfig.getAccessToken(),
        profile = playerConfig.getProfileId(),
        pin = playerConfig.getProfileToken?.();
      const generation = downloadGeneration.current;
      uploadedSubtitle.current = undefined;
      const response = await playerV2(playerConfig, "POST /api/v2/subtitles/upload", {
        form: {
          media_file_id: String(input.mediaFileId),
          file: input.file,
          language: input.language,
          language_override: input.languageOverride ? "true" : "false",
          hearing_impaired: input.hearingImpaired ? "true" : "false",
        },
      });
      if (
        generation !== downloadGeneration.current ||
        token !== playerConfig.getAccessToken() ||
        profile !== playerConfig.getProfileId() ||
        pin !== playerConfig.getProfileToken?.()
      )
        throw new DOMException("Subtitle upload context changed", "AbortError");
      uploadedSubtitle.current = response?.subtitle;
    },
    [playerConfig],
  );

  const handleDetectLanguage = useCallback(
    async (file: File, fallbackLanguage?: string): Promise<SubtitleLanguageDetection> => {
      const token = playerConfig.getAccessToken(),
        profile = playerConfig.getProfileId(),
        pin = playerConfig.getProfileToken?.();
      const generation = downloadGeneration.current;
      const result = await playerV2(playerConfig, "POST /api/v2/subtitles/detect-language", {
        form: { file, language: fallbackLanguage },
      });
      if (
        generation !== downloadGeneration.current ||
        token !== playerConfig.getAccessToken() ||
        profile !== playerConfig.getProfileId() ||
        pin !== playerConfig.getProfileToken?.()
      )
        throw new DOMException("Subtitle detection context changed", "AbortError");
      return result;
    },
    [playerConfig],
  );

  const handleUploadSuccess = useCallback(() => {
    onSubtitleDownloaded(uploadedSubtitle.current);
    handleClose();
  }, [onSubtitleDownloaded, handleClose]);

  const handleDownload = useCallback(
    async (result: SubtitleResult) => {
      const generation = downloadGeneration.current;
      const token = playerConfig.getAccessToken();
      const profile = playerConfig.getProfileId();
      const pin = playerConfig.getProfileToken?.();
      const current = () =>
        generation === downloadGeneration.current &&
        token === playerConfig.getAccessToken() &&
        profile === playerConfig.getProfileId() &&
        pin === playerConfig.getProfileToken?.();
      const key = `${result.provider}:${result.id}`;
      setDownloading(key);
      setError(null);

      try {
        const response = await playerV2(playerConfig, "POST /api/v2/subtitles/download", {
          body: {
            media_file_id: String(mediaFileId),
            provider: result.provider,
            subtitle_id: result.id,
            language: result.language,
            release_name: result.release_name,
            score: result.score,
            hearing_impaired: result.hearing_impaired,
          },
        });
        if (!current()) return;
        onSubtitleDownloaded(response?.subtitle);
        handleClose();
      } catch (err) {
        if (current()) setError(err instanceof Error ? err.message : "Download failed");
      } finally {
        if (current()) setDownloading(null);
      }
    },
    [playerConfig, mediaFileId, onSubtitleDownloaded, handleClose],
  );

  const translationSource =
    searchedLang === selectedLang
      ? translationSourceForRequest(tracks, selectedLang, translationEnabled)
      : null;

  const handleTranslate = useCallback(async () => {
    if (!translationSource) return;
    const generation = downloadGeneration.current;
    const token = playerConfig.getAccessToken();
    const profile = playerConfig.getProfileId();
    const pin = playerConfig.getProfileToken?.();
    const current = () =>
      generation === downloadGeneration.current &&
      token === playerConfig.getAccessToken() &&
      profile === playerConfig.getProfileId() &&
      pin === playerConfig.getProfileToken?.();
    setDownloading("translate");
    setError(null);
    try {
      const body = buildSubtitleTranslateRequest({
        mode: "subtitles",
        mediaFileId,
        sourceTracks: tracks,
        effectiveSourceIndex: translationSource.index,
        targetLang: selectedLang,
        sessionId,
        startPosition: getStartPosition?.() ?? 0,
      });
      const res = await playerV2(playerConfig, "POST /api/v2/subtitles/ai/translate", {
        body: { ...body, media_file_id: String(mediaFileId), kind: body.kind ?? "translate" },
      });
      if (!current()) return;
      if (
        !res ||
        !/^[1-9][0-9]*$/.test(res.job.id) ||
        res.job.media_file_id !== String(mediaFileId) ||
        res.job.kind !== (body.kind ?? "translate") ||
        res.job.source_index !== body.source_index
      ) {
        throw new Error("Subtitle processing returned an invalid job.");
      }
      const reusedSubtitleId =
        res.job.status === "completed" ? (res.job.result_subtitle_id ?? undefined) : undefined;
      onSubtitleJobAccepted?.(res.job.id, reusedSubtitleId);
      if (reusedSubtitleId) {
        toast.info("These subtitles were already created, so the saved track is selected.");
      } else if (!res.live_delivery_attached) {
        toast.info("Your subtitle job is underway. The track will appear when it's ready.");
      }
      handleClose();
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof PlayerFetchError || err instanceof Error
          ? err.message
          : "Couldn't start translation.",
      );
    } finally {
      if (current()) setDownloading(null);
    }
  }, [
    translationSource,
    playerConfig,
    mediaFileId,
    tracks,
    selectedLang,
    sessionId,
    getStartPosition,
    onSubtitleJobAccepted,
    handleClose,
  ]);

  if (!isOpen) return null;

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add Subtitles"
      onKeyDown={handleFocusTrap}
    >
      <div
        ref={modalRef}
        className="w-full max-w-[480px] rounded-lg bg-neutral-900 text-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold">Add Subtitles</h2>
          <button
            type="button"
            className="rounded text-white/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
            onClick={handleClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <SubtitleUploadForm
          mediaFileId={mediaFileId}
          upload={handleUpload}
          detectLanguage={handleDetectLanguage}
          onSuccess={handleUploadSuccess}
          variant="player"
          defaultLanguage={selectedLang}
        />

        {onlineSearchEnabled && (
          <div className="border-b border-white/10 px-4 py-2">
            <p className="text-xs font-medium text-white/60">Search online</p>
          </div>
        )}

        {/* Search controls */}
        {onlineSearchEnabled && (
          <div className="flex gap-2 px-4 py-3">
            <select
              ref={searchInputRef}
              aria-label="Language"
              className="flex-1 rounded bg-neutral-800 px-2 py-1.5 text-sm text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
              value={selectedLang}
              onChange={(e) => setSelectedLang(e.target.value)}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-50"
              onClick={handleSearch}
              disabled={searching}
            >
              {searching ? "Searching\u2026" : "Search"}
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            role="alert"
            className="mx-4 mb-3 rounded bg-red-900/40 px-3 py-2 text-xs text-red-300"
          >
            {error}
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div role="status" className="mx-4 mb-2 space-y-1">
            {warnings.map((w, i) => (
              <div key={i} className="rounded bg-yellow-900/40 px-3 py-1.5 text-xs text-yellow-300">
                {w}
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {onlineSearchEnabled && (
          <div className="max-h-[60vh] overflow-y-auto px-4 pb-4">
            {results.length === 0 && !searching && !error && !translationSource && (
              <p className="py-6 text-center text-xs text-white/40">
                {searchedLang === selectedLang
                  ? "No subtitles in that language."
                  : "Select a language and press Search."}
              </p>
            )}

            {translationSource && (
              <button
                type="button"
                className="mb-1.5 flex w-full items-center gap-2 rounded bg-white/5 px-3 py-2 text-left hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-50"
                onClick={() => void handleTranslate()}
                disabled={downloading !== null}
              >
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                  style={{
                    backgroundColor: `${providerInfo.translate.color}22`,
                    color: providerInfo.translate.color,
                    border: `1px solid ${providerInfo.translate.color}55`,
                  }}
                >
                  {providerInfo.translate.abbr}
                </span>
                <span className="min-w-0 flex-1 text-xs">
                  Translate {sourceLabel(translationSource)} into{" "}
                  {getLanguageName(selectedLang) || selectedLang}
                </span>
              </button>
            )}

            {results.map((result) => {
              const key = `${result.provider}:${result.id}`;
              const isDownloading = downloading === key;
              const info = providerInfo[result.provider];

              return (
                <button
                  key={key}
                  type="button"
                  className="mb-1.5 flex w-full items-center gap-2 rounded bg-white/5 px-3 py-2 text-left hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none disabled:opacity-50"
                  onClick={() => handleDownload(result)}
                  disabled={downloading !== null}
                >
                  {/* Score badge */}
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-xs font-bold tabular-nums"
                    style={{
                      backgroundColor: `${scoreColor(result.score)}22`,
                      color: scoreColor(result.score),
                      border: `1px solid ${scoreColor(result.score)}55`,
                    }}
                  >
                    {result.score}
                  </span>

                  {/* Release name */}
                  <span className="min-w-0 flex-1 truncate text-xs">{result.release_name}</span>

                  {/* HI badge */}
                  {result.hearing_impaired && (
                    <span className="shrink-0 rounded bg-white/10 px-1 py-0.5 text-[10px] text-white/60">
                      HI
                    </span>
                  )}

                  {/* Download count */}
                  <span className="shrink-0 text-[10px] text-white/40">
                    ↓{result.downloads.toLocaleString()}
                  </span>

                  {/* Provider badge */}
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      backgroundColor: `${info?.color ?? "#6b7280"}22`,
                      color: info?.color ?? "#9ca3af",
                      border: `1px solid ${info?.color ?? "#6b7280"}55`,
                    }}
                  >
                    {info?.abbr ?? result.provider}
                  </span>

                  {/* Download spinner */}
                  {isDownloading && (
                    <span className="shrink-0 text-xs text-white/60" aria-label="Downloading">
                      ⟳
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
