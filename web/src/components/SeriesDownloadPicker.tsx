import { useState } from "react";
import type { EpisodeListItem, FileVersion } from "@/api/types";
import DownloadVersionPicker from "@/components/DownloadVersionPicker";
import { useSeasonEpisodes, useSeasons } from "@/hooks/queries/episodes";

interface SeriesDownloadPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string;
  title: string;
  initialSeasonNumber?: number;
  initialEpisodeId?: string;
}

function downloadable(episode: EpisodeListItem) {
  return episode.files.some((file) => !file.unreadable);
}

/** Select an available episode, then an existing file. No conversion is offered here. */
export default function SeriesDownloadPicker({
  open,
  onOpenChange,
  seriesId,
  title,
  initialSeasonNumber,
  initialEpisodeId,
}: SeriesDownloadPickerProps) {
  const [pickedSeason, setPickedSeason] = useState<number | null>(null);
  const [pickedEpisodeId, setPickedEpisodeId] = useState<string | null>(null);
  const seasonsQuery = useSeasons(open ? seriesId : undefined);
  const seasons = seasonsQuery.data?.seasons ?? [];
  const seasonNumber =
    seasons.find((season) => season.season_number === pickedSeason)?.season_number ??
    seasons.find((season) => season.season_number === initialSeasonNumber)?.season_number ??
    seasons[0]?.season_number;
  const episodesQuery = useSeasonEpisodes(
    open && seasonNumber !== undefined ? seriesId : undefined,
    seasonNumber ?? -1,
  );
  const episodes = episodesQuery.data?.episodes.filter(downloadable) ?? [];
  const episode =
    episodes.find((candidate) => candidate.content_id === pickedEpisodeId) ??
    episodes.find((candidate) => candidate.content_id === initialEpisodeId) ??
    episodes[0];
  const versions: FileVersion[] =
    episode?.files
      .filter((file) => !file.unreadable)
      .map((file) => ({
        ...file,
        codec_audio: "",
        duration: episode.runtime * 60,
        bitrate: 0,
      })) ?? [];

  const controls = (
    <div className="bg-muted/30 grid gap-3 rounded-xl border p-3 sm:grid-cols-2">
      <label className="space-y-1.5 text-sm font-medium">
        <span className="text-muted-foreground block text-xs font-semibold tracking-wide uppercase">
          1. Season
        </span>
        <select
          value={seasonNumber ?? ""}
          onChange={(event) => {
            setPickedSeason(Number(event.target.value));
            setPickedEpisodeId(null);
          }}
          disabled={seasonsQuery.isLoading || seasons.length === 0}
          className="border-input bg-background text-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2.5 focus-visible:ring-2 focus-visible:outline-none"
        >
          {seasons.length === 0 && <option value="">No seasons</option>}
          {seasons.map((season) => (
            <option key={season.content_id} value={season.season_number}>
              {season.is_specials ? "Specials" : `Season ${season.season_number}`}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1.5 text-sm font-medium">
        <span className="text-muted-foreground block text-xs font-semibold tracking-wide uppercase">
          2. Episode
        </span>
        <select
          value={episode?.content_id ?? ""}
          onChange={(event) => setPickedEpisodeId(event.target.value)}
          disabled={episodesQuery.isLoading || episodes.length === 0}
          className="border-input bg-background text-foreground focus-visible:ring-ring w-full rounded-lg border px-3 py-2.5 focus-visible:ring-2 focus-visible:outline-none"
        >
          {episodes.length === 0 && <option value="">No available episodes</option>}
          {episodes.map((candidate) => (
            <option key={candidate.content_id} value={candidate.content_id}>
              {`E${String(candidate.episode_number).padStart(2, "0")} - ${candidate.title || `Episode ${candidate.episode_number}`}`}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground text-xs sm:col-span-2" role="status">
        {seasonsQuery.isError || episodesQuery.isError
          ? "Could not load the available episodes. Try again."
          : seasonsQuery.isLoading || episodesQuery.isLoading
            ? "Loading available episodes..."
            : episode
              ? `3. Choose a file for ${episode.title || `Episode ${episode.episode_number}`}.`
              : "No downloadable episodes are available in this season."}
      </p>
    </div>
  );

  return (
    <DownloadVersionPicker
      open={open}
      onOpenChange={onOpenChange}
      versions={versions}
      title={title}
      selectionControls={controls}
    />
  );
}
