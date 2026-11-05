import { expect, it } from "vitest";
import type { PlayerSubtitleInfo } from "../types";
import { translationSourceForRequest } from "./subtitleTranslateRequest";

function track(
  partial: Partial<PlayerSubtitleInfo> & Pick<PlayerSubtitleInfo, "index" | "language">,
): PlayerSubtitleInfo {
  return {
    label: partial.language,
    url: "/subtitle",
    source: "embedded",
    codec: "srt",
    ...partial,
  };
}

it("offers a text track when the requested language is not on the file", () => {
  const source = track({ index: 2, language: "ja", source: "external", codec: "srt" });
  expect(
    translationSourceForRequest(
      [source, track({ index: 0, language: "en", codec: "hdmv_pgs_subtitle" })],
      "da",
      true,
    ),
  ).toBe(source);
});

it("does not offer a translation of a language the file already has", () => {
  expect(
    translationSourceForRequest(
      [track({ index: 0, language: "en" }), track({ index: 1, language: "ja" })],
      "en",
      true,
    ),
  ).toBeNull();
});

it("does not offer a translation when none is configured or no text track exists", () => {
  const bitmap = track({ index: 0, language: "ja", codec: "hdmv_pgs_subtitle" });
  expect(translationSourceForRequest([bitmap], "da", true)).toBeNull();
  expect(
    translationSourceForRequest([track({ index: 1, language: "ja" })], "da", false),
  ).toBeNull();
});
