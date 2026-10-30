import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { EpisodeListItem, Season } from "@/api/types";
import SeriesDownloadPicker from "./SeriesDownloadPicker";

const mocks = vi.hoisted(() => ({ seasons: vi.fn(), episodes: vi.fn(), launch: vi.fn() }));
vi.mock("@/hooks/queries/episodes", () => ({
  useSeasons: mocks.seasons,
  useSeasonEpisodes: mocks.episodes,
}));
vi.mock("@/api/v2/directDownloads", () => ({ launchDirectDownload: mocks.launch }));

const seasons = [
  { content_id: "season-1", season_number: 1, is_specials: false },
  { content_id: "season-2", season_number: 2, is_specials: false },
] as Season[];
const episodes = (season: number): EpisodeListItem[] =>
  season === 1
    ? [
        {
          content_id: "episode-1",
          season_number: 1,
          episode_number: 1,
          overview: "",
          air_date: null,
          runtime: 42,
          still_url: "",
          still_thumbhash: "",
          title: "Pilot",
          files: [{ file_id: 11, resolution: "1080p", container: "mkv", file_size: 1024 }],
        } as EpisodeListItem,
        {
          content_id: "episode-2",
          season_number: 1,
          episode_number: 2,
          overview: "",
          air_date: null,
          runtime: 42,
          still_url: "",
          still_thumbhash: "",
          title: "Missing file",
          files: [],
        } as EpisodeListItem,
      ]
    : [
        {
          content_id: "episode-3",
          season_number: 2,
          episode_number: 3,
          overview: "",
          air_date: null,
          runtime: 42,
          still_url: "",
          still_thumbhash: "",
          title: "Return",
          files: [{ file_id: 23, resolution: "720p", container: "mp4", file_size: 2048 }],
        } as EpisodeListItem,
      ];

it("changes the available episode and file with the season", async () => {
  mocks.seasons.mockReturnValue({ data: { seasons }, isLoading: false });
  mocks.episodes.mockImplementation((_id: string, season: number) => ({
    data: { episodes: episodes(season) },
    isLoading: false,
  }));
  mocks.launch.mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <SeriesDownloadPicker
      open
      onOpenChange={close}
      seriesId="series-1"
      title="Example Show"
      initialSeasonNumber={1}
    />,
  );
  expect(screen.getByRole("combobox", { name: /episode/i })).toHaveValue("episode-1");
  expect(screen.queryByRole("option", { name: /Missing file/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: /season/i }), { target: { value: "2" } });
  expect(screen.getByRole("combobox", { name: /episode/i })).toHaveValue("episode-3");
  expect(screen.getByRole("button", { name: /720p/ })).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Download selected file" }));
  });
  expect(mocks.launch).toHaveBeenCalledWith(23, expect.any(Function));
  expect(close).toHaveBeenCalledWith(false);
});
