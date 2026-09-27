/**
 * Minimal YouTube Music "internal API" client for the Workers runtime.
 *
 * This is a direct, verified port of the relevant paths in sigma67/ytmusicapi
 * (checked against the actual source, not reconstructed from memory):
 *   - ytmusicapi/helpers.py       (sapisid_from_cookie, get_authorization, initialize_context)
 *   - ytmusicapi/constants.py     (YTM_BASE_API, YTM_PARAMS, YTM_PARAMS_KEY, USER_AGENT)
 *   - ytmusicapi/ytmusic.py       (YTMusicBase: headers, _send_request)
 *   - ytmusicapi/mixins/playlists.py (get_playlist, add_playlist_items, remove_playlist_items, edit_playlist)
 *   - ytmusicapi/parsers/playlists.py (parse_playlist_item, validate_playlist_id)
 *   - ytmusicapi/navigation.py    (path constants used below)
 *   - ytmusicapi/continuations.py (get_continuations_2025 + get_continuation_token)
 *
 * Only the subset needed to purge/refill a playlist from Liked Music is
 * ported -- not the whole library's surface.
 */

export interface YtEnv {
  YT_COOKIE: string;
}

// --- constants.py -----------------------------------------------------------
const YTM_DOMAIN = "https://music.youtube.com";
const YTM_BASE_API = `${YTM_DOMAIN}/youtubei/v1/`;
const YTM_PARAMS = "?alt=json";
const YTM_PARAMS_KEY = "&key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0";

// --- helpers.py ---------------------------------------------------------------
function sapisidFromCookie(rawCookie: string): string {
  // real code: SimpleCookie().load(raw_cookie.replace('"', "")) -- reads __Secure-3PAPISID specifically
  const match = rawCookie.replace(/"/g, "").match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/);
  if (!match) {
    throw new Error("Your cookie is missing the required value __Secure-3PAPISID");
  }
  return match[1];
}

async function sha1Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** get_authorization(auth): auth = "<SAPISID> <origin>" */
async function getAuthorization(auth: string): Promise<string> {
  const unixTimestamp = String(Math.floor(Date.now() / 1000));
  const hash = await sha1Hex(`${unixTimestamp} ${auth}`);
  return `SAPISIDHASH ${unixTimestamp}_${hash}`;
}

function initializeContext(): { context: { client: Record<string, string>; user: Record<string, never> } } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return {
    context: {
      client: { clientName: "WEB_REMIX", clientVersion: `1.${y}${m}${d}.01.00`, hl: "en" },
      user: {},
    },
  };
}

/** get_visitor_id: GET music.youtube.com, scrape ytcfg.set({...}) for VISITOR_DATA */
async function fetchVisitorId(): Promise<string> {
  const res = await fetch(YTM_DOMAIN, { headers: { "user-agent": USER_AGENT } });
  const text = await res.text();
  const match = text.match(/ytcfg\.set\s*\(\s*({.+?})\s*\)\s*;/);
  if (!match) return "";
  try {
    return JSON.parse(match[1]).VISITOR_DATA ?? "";
  } catch {
    return "";
  }
}

export interface TrackRef {
  videoId: string;
  setVideoId?: string;
  videoType?: string;
}

export class YTMusic {
  private sapisid: string;
  private origin = YTM_DOMAIN;
  private visitorId: string | null = null;
  private context = initializeContext();

  constructor(private cookie: string) {
    this.sapisid = sapisidFromCookie(cookie);
  }

  private async headers(): Promise<Record<string, string>> {
    if (this.visitorId === null) {
      this.visitorId = await fetchVisitorId();
    }
    return {
      cookie: `${this.cookie}; SOCS=CAI`, // real client sends SOCS=CAI as an additional cookie, see ytmusic.py
      authorization: await getAuthorization(`${this.sapisid} ${this.origin}`),
      "x-goog-authuser": "0",
      "x-goog-visitor-id": this.visitorId,
      origin: this.origin,
      "user-agent": USER_AGENT,
      "content-type": "application/json",
      accept: "*/*",
    };
  }

  /** ytmusic.py: YTMusicBase._send_request */
  private async sendRequest(endpoint: string, body: Record<string, unknown>): Promise<any> {
    const fullBody = { ...body, ...this.context };
    const res = await fetch(`${YTM_BASE_API}${endpoint}${YTM_PARAMS}${YTM_PARAMS_KEY}`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(fullBody),
    });
    const data: any = await res.json();
    if (res.status >= 400) {
      const message = `Server returned HTTP ${res.status}: ${res.statusText}.`;
      throw new Error(`${message} ${data?.error?.message ?? ""}`);
    }
    return data;
  }

  /**
   * mixins/playlists.py: get_playlist(playlistId, limit=None), restricted to the
   * non-OLA (normal playlist / Liked Music) branch, and only extracting the
   * fields (videoId, setVideoId, videoType) the sync logic needs.
   */
  async getPlaylistTracks(playlistId: string): Promise<TrackRef[]> {
    const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
    const response = await this.sendRequest("browse", { browseId });

    const sectionList =
      response?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer;
    const contentData = sectionList?.contents?.[0]?.musicPlaylistShelfRenderer;
    if (!contentData) return [];

    const tracks: TrackRef[] = parsePlaylistItems(contentData.contents ?? []);

    // continuations.py: get_continuations_2025
    let continuationToken = getContinuationToken(contentData.contents ?? []);
    while (continuationToken) {
      const contResponse = await this.sendRequest("browse", { continuation: continuationToken });
      const continuationItems = contResponse?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction
        ?.continuationItems;
      if (!continuationItems || continuationItems.length === 0) break;
      const parsed = parsePlaylistItems(continuationItems);
      if (parsed.length === 0) break;
      tracks.push(...parsed);
      continuationToken = getContinuationToken(continuationItems);
    }

    return tracks;
  }

  /** mixins/playlists.py: remove_playlist_items */
  async removePlaylistItems(playlistId: string, tracks: TrackRef[]): Promise<void> {
    const videos = tracks.filter((t) => t.videoId && t.setVideoId);
    if (videos.length === 0) return;
    const actions = videos.map((t) => ({
      setVideoId: t.setVideoId,
      removedVideoId: t.videoId,
      action: "ACTION_REMOVE_VIDEO",
    }));
    await this.sendRequest("browse/edit_playlist", { playlistId: validatePlaylistId(playlistId), actions });
  }

  /** mixins/playlists.py: add_playlist_items(playlistId, videoIds, duplicates=True) */
  async addPlaylistItems(playlistId: string, videoIds: string[]): Promise<void> {
    if (videoIds.length === 0) return;
    const actions = videoIds.map((videoId) => ({
      action: "ACTION_ADD_VIDEO",
      addedVideoId: videoId,
      dedupeOption: "DEDUPE_OPTION_SKIP", // set because the original script calls duplicates=True
    }));
    await this.sendRequest("browse/edit_playlist", { playlistId: validatePlaylistId(playlistId), actions });
  }

  /** mixins/playlists.py: edit_playlist(description=...) */
  async editPlaylistDescription(playlistId: string, description: string): Promise<void> {
    await this.sendRequest("browse/edit_playlist", {
      playlistId: validatePlaylistId(playlistId),
      actions: [{ action: "ACTION_SET_PLAYLIST_DESCRIPTION", playlistDescription: description }],
    });
  }
}

// --- parsers/playlists.py: validate_playlist_id -----------------------------
function validatePlaylistId(playlistId: string): string {
  return playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
}

// --- continuations.py: get_continuation_token --------------------------------
function getContinuationToken(results: any[]): string | null {
  if (results.length === 0) return null;
  const last = results[results.length - 1];
  const direct = last?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
  if (direct) return direct;
  const commands = last?.continuationItemRenderer?.continuationEndpoint?.commandExecutorCommand?.commands ?? [];
  for (const command of commands) {
    if (command?.continuationCommand?.request === "CONTINUATION_REQUEST_TYPE_BROWSE") {
      return command.continuationCommand.token ?? null;
    }
  }
  return null;
}

// --- parsers/playlists.py: parse_playlist_items / parse_playlist_item -------
// (trimmed to just the fields the sync logic needs: videoId, setVideoId, videoType)
const MRLIR = "musicResponsiveListItemRenderer";
const MNIR = "menuNavigationItemRenderer";

function parsePlaylistItems(results: any[]): TrackRef[] {
  const songs: TrackRef[] = [];
  for (const result of results) {
    const data = result?.[MRLIR];
    if (!data) continue;
    const song = parsePlaylistItem(data);
    if (song) songs.push(song);
  }
  return songs;
}

function parsePlaylistItem(data: any): TrackRef | null {
  let videoId: string | null = null;
  let setVideoId: string | undefined;

  // if the item has a menu, find its setVideoId (and, for unavailable items, videoId)
  const menuItems = data?.menu?.menuRenderer?.items ?? [];
  for (const item of menuItems) {
    const serviceEndpoint = item?.menuServiceItemRenderer?.serviceEndpoint;
    if (serviceEndpoint?.playlistEditEndpoint) {
      const action = serviceEndpoint.playlistEditEndpoint.actions?.[0];
      setVideoId = action?.setVideoId;
      if (action?.removedVideoId) videoId = action.removedVideoId;
    }
  }

  // if the item is playable, videoId comes from the play button overlay instead
  const playButton = data?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer;
  if (playButton?.playNavigationEndpoint?.watchEndpoint?.videoId) {
    videoId = playButton.playNavigationEndpoint.watchEndpoint.videoId;
  }

  if (!videoId) return null;

  // title == "Song deleted" is dropped by the real parser; we don't have an
  // easy title here without more parsing, so this is intentionally omitted --
  // such an item would just carry no title-based filtering in this port.

  const videoType: string | undefined =
    menuItems[0]?.[MNIR]?.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType;

  return { videoId, setVideoId, videoType };
}
