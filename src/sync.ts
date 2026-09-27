import { YTMusic, TrackRef } from "./ytmusic";

const CUSTOM_DESC = "Auto updates with songs I cherish.";

interface Shape {
  trackCount: number;
  videoCount: number;
  lastVideoId: string | null;
  lastTrackId: string | null;
  tracks: TrackRef[];
}

function shapeOf(tracks: TrackRef[]): Shape {
  const atv = tracks.filter((t) => t.videoType === "MUSIC_VIDEO_TYPE_ATV");
  const other = tracks.filter((t) => t.videoType !== "MUSIC_VIDEO_TYPE_ATV");
  return {
    trackCount: atv.length,
    videoCount: other.length,
    lastVideoId: tracks.length ? tracks[tracks.length - 1].videoId ?? null : null,
    lastTrackId: atv.length ? atv[atv.length - 1].videoId ?? null : null,
    tracks,
  };
}

function shapesMatch(source: Shape, target: Shape, log: string[]): boolean {
  if (source.videoCount === 0 && source.trackCount === 0) return false;
  if (target.videoCount === 0 && target.trackCount === 0) {
    log.push("Target is empty -- shape check skipped.");
    return false;
  }
  if (source.trackCount !== target.trackCount) {
    log.push(`Shape mismatch: track counts differ (${source.trackCount} vs ${target.trackCount}).`);
    return false;
  }
  if (source.videoCount !== target.videoCount) {
    log.push(`Shape mismatch: video counts differ (${source.videoCount} vs ${target.videoCount}).`);
    return false;
  }
  if (source.lastVideoId !== target.lastVideoId) {
    log.push(`Shape mismatch: last video differs (${source.lastVideoId} vs ${target.lastVideoId}).`);
    return false;
  }
  if (source.lastTrackId !== target.lastTrackId) {
    log.push(`Shape mismatch: last track differs (${source.lastTrackId} vs ${target.lastTrackId}).`);
    return false;
  }
  log.push("Shape check passed: counts and last track/video match. Skipping purge/refill.");
  return true;
}

async function doPurge(yt: YTMusic, playlistId: string, log: string[]): Promise<boolean> {
  let current: TrackRef[];
  try {
    current = await yt.getPlaylistTracks(playlistId);
  } catch (e) {
    log.push(`Error fetching playlist ${playlistId}: ${e}`);
    return false;
  }
  if (current.length === 0) {
    log.push("Playlist already empty.");
    return true;
  }
  log.push(`Purging ${current.length} track(s)...`);
  try {
    await yt.removePlaylistItems(playlistId, current);
    log.push("Purge request sent.");
  } catch (e) {
    log.push(`Error purging tracks from ${playlistId}: ${e}`);
    return false;
  }
  let remaining: TrackRef[];
  try {
    remaining = await yt.getPlaylistTracks(playlistId);
  } catch (e) {
    log.push(`Could not verify purge of ${playlistId} (fetch failed): ${e}`);
    return false;
  }
  if (remaining.length === 0) {
    log.push("Purge confirmed empty.");
    return true;
  }
  log.push(`${remaining.length} item(s) still present after purge.`);
  return false;
}

async function doRefill(yt: YTMusic, playlistId: string, videoIds: string[], log: string[]): Promise<boolean> {
  if (videoIds.length === 0) {
    log.push("No tracks to add.");
    return true;
  }
  log.push(`Refilling with ${videoIds.length} track(s)...`);
  try {
    await yt.addPlaylistItems(playlistId, videoIds);
    log.push("Refill request sent.");
  } catch (e) {
    log.push(`Error refilling tracks into ${playlistId}: ${e}`);
    return false;
  }
  let current: TrackRef[];
  try {
    current = await yt.getPlaylistTracks(playlistId);
  } catch (e) {
    log.push(`Could not verify refill of ${playlistId} (fetch failed): ${e}`);
    return false;
  }
  const currentIds = new Set(current.map((t) => t.videoId));
  const missing = videoIds.filter((id) => !currentIds.has(id));
  if (missing.length > 0) {
    log.push(`${missing.length} track(s) still missing after refill.`);
    return false;
  }
  log.push("Refill confirmed complete.");
  return true;
}

async function purgeAndRefill(
  yt: YTMusic,
  playlistId: string,
  videoIds: string[],
  log: string[],
  maxAttempts = 5,
  retryDelayMs = 2000
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.push(`Cycle attempt ${attempt}/${maxAttempts}...`);

    if (!(await doPurge(yt, playlistId, log))) {
      if (attempt < maxAttempts) {
        log.push(`Purge/verify failed, retrying whole cycle in ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`Purge could not be confirmed for playlist ${playlistId} after ${maxAttempts} full cycle attempts.`);
    }

    if (!(await doRefill(yt, playlistId, videoIds, log))) {
      if (attempt < maxAttempts) {
        log.push(`Refill/verify failed, retrying whole cycle in ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(`Refill could not be confirmed for playlist ${playlistId} after ${maxAttempts} full cycle attempts.`);
    }

    log.push("Cycle confirmed: purge and refill both verified.");
    await yt.editPlaylistDescription(playlistId, formatDescription(CUSTOM_DESC));
    return;
  }
}

function formatDescription(base: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).split("-").reverse().join("/");
  const time = now.toISOString().slice(11, 16);
  return `Last updated: ${date} at ${time} GMT\n${base}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function syncFromLikedMusic(cookie: string, targetPlaylistId: string): Promise<string[]> {
  const log: string[] = [];
  const yt = new YTMusic(cookie);

  log.push("Fetching Liked Music tracks...");
  let lmTracks: TrackRef[];
  try {
    lmTracks = await yt.getPlaylistTracks("LM");
  } catch (e) {
    throw new Error(`Error fetching Liked Music: ${e}`);
  }
  if (lmTracks.length === 0) {
    log.push("Liked Music is empty — nothing to sync.");
    return log;
  }
  const lmShape = shapeOf(lmTracks);
  log.push(`Liked Music: ${lmShape.trackCount} track(s), ${lmShape.videoCount} regular video(s)`);

  log.push(`Checking shape of target playlist (${targetPlaylistId})...`);
  let targetTracks: TrackRef[];
  try {
    targetTracks = await yt.getPlaylistTracks(targetPlaylistId);
  } catch (e) {
    throw new Error(`Error fetching target playlist ${targetPlaylistId}: ${e}`);
  }
  const targetShape = shapeOf(targetTracks);

  if (shapesMatch(lmShape, targetShape, log)) {
    return log;
  }

  const lmVideoIds = lmTracks.map((t) => t.videoId).filter(Boolean);
  log.push(`Syncing target playlist (${targetPlaylistId})...`);
  await purgeAndRefill(yt, targetPlaylistId, lmVideoIds, log);
  return log;
}
