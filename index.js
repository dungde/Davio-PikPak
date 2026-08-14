const http = require("http");
const https = require("https");

// ============================================================
// PIKPAK CONFIG
// ============================================================
// Hiện tại vẫn nhập trực tiếp username/password.
// Sau này có thể chuyển sang process.env mà không phải viết lại
// phần search / stream.
//
// Ví dụ sau này:
// username: process.env.PIKPAK_USERNAME,
// password: process.env.PIKPAK_PASSWORD
// ============================================================

const WEBDAV_CONFIG = {
  baseUrl: "https://dav.mypikpak.com",
  username: "YOUR_PIKPAK_USERNAME",
  password: "YOUR_PIKPAK_PASSWORD"
};

// ============================================================
// SERVER CONFIG
// ============================================================

const PORT = process.env.PORT || 3000;

const ADDON_VERSION = "1.0.0";

// ============================================================
// AUTH
// ============================================================

function getAuthHeader(username, password) {
  return (
    "Basic " +
    Buffer.from(`${username}:${password}`, "latin1").toString("base64")
  );
}

// ============================================================
// WEBDAV PROPFIND
// ============================================================

const PROPFIND_XML = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>`;

// ============================================================
// CACHE
// ============================================================

let FILE_CACHE = [];
let isScanning = false;
let lastScanTime = null;

// ============================================================
// VIDEO EXTENSIONS
// ============================================================

const VIDEO_EXTENSIONS = [
  "mp4",
  "mkv",
  "avi",
  "mov",
  "m4v",
  "webm",
  "ts",
  "m2ts",
  "m3u8"
];

function isVideoFile(path) {
  const lower = path.toLowerCase();

  return VIDEO_EXTENSIONS.some((ext) =>
    lower.endsWith("." + ext)
  );
}

// ============================================================
// URL ENCODING
// ============================================================

function encodeWebDavPath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// ============================================================
// XML ENTITY DECODER
// ============================================================

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

// ============================================================
// NORMALIZE TITLE
// ============================================================
//
// Ví dụ:
//
// "My.Youth.S01.1080p.WEB-DL"
// ->
// "my youth s01"
//
// "F1: The Movie"
// ->
// "f1 the movie"
//
// "Avatar (2009)"
// ->
// "avatar 2009"
// ============================================================

function normalizeTitle(value) {
  if (!value) return "";

  let text = String(value);

  text = decodeXmlEntities(text);

  // Decode URL encoding nếu có
  try {
    text = decodeURIComponent(text);
  } catch (e) {}

  text = text
    .replace(/\.[a-z0-9]{2,5}$/i, "") // bỏ extension
    .replace(/[._]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/[()[\]{}]/g, " ")
    .replace(/[:;,!?'"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  return text;
}

// ============================================================
// REMOVE RELEASE TAGS
// ============================================================
//
// "My Youth S01 1080p WEB DL AAC2 0 H 264 BlackTV"
// ->
// "my youth s01"
//
// Giúp tìm được phim dù tên file chứa rất nhiều release info.
// ============================================================

function removeReleaseTags(value) {
  if (!value) return "";

  let text = normalizeTitle(value);

  const releasePatterns = [
    /\b\d{3,4}p\b/gi,
    /\b4k\b/gi,
    /\b2160p\b/gi,
    /\b1080p\b/gi,
    /\b720p\b/gi,
    /\b576p\b/gi,
    /\b480p\b/gi,

    /\bweb[- ]?dl\b/gi,
    /\bweb[- ]?rip\b/gi,
    /\bwebrip\b/gi,
    /\bhdtv\b/gi,
    /\bbluray\b/gi,
    /\bbrrip\b/gi,
    /\bdvdrip\b/gi,
    /\bdvd\b/gi,

    /\bx264\b/gi,
    /\bx265\b/gi,
    /\bh264\b/gi,
    /\bh265\b/gi,
    /\bhevc\b/gi,
    /\bavc\b/gi,

    /\baac\d?(?:\.\d)?\b/gi,
    /\bddp\d?(?:\.\d)?\b/gi,
    /\bac3\b/gi,
    /\bdts\b/gi,
    /\batmos\b/gi,

    /\b10bit\b/gi,
    /\b8bit\b/gi,

    /\bproper\b/gi,
    /\brepack\b/gi,
    /\bremux\b/gi,
    /\bextended\b/gi,
    /\bunrated\b/gi,
    /\binternal\b/gi,

    /\bwww\b/gi,
    /\bcom\b/gi,

    // Một số release group phổ biến
    /\byts\b/gi,
    /\bblacktv\b/gi,
    /\bntb\b/gi,
    /\bntg\b/gi,
    /\bflux\b/gi,
    /\baoc\b/gi,
    /\bbonе\b/gi
  ];

  for (const pattern of releasePatterns) {
    text = text.replace(pattern, " ");
  }

  return text.replace(/\s+/g, " ").trim();
}

// ============================================================
// TOKENIZE
// ============================================================

function tokenize(value) {
  return removeReleaseTags(value)
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ============================================================
// SEASON / EPISODE
// ============================================================

function extractSeason(value) {
  if (!value) return null;

  const text = normalizeTitle(value);

  // S01
  let match = text.match(/\bs(\d{1,2})\b/i);

  if (match) {
    return parseInt(match[1], 10);
  }

  // Season 1
  match = text.match(/\bseason\s*(\d{1,2})\b/i);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

function extractEpisode(value) {
  if (!value) return null;

  const text = normalizeTitle(value);

  // S01E05
  let match = text.match(/\bs\d{1,2}e(\d{1,3})\b/i);

  if (match) {
    return parseInt(match[1], 10);
  }

  // Episode 5
  match = text.match(/\bepisode\s*(\d{1,3})\b/i);

  if (match) {
    return parseInt(match[1], 10);
  }

  // E05
  match = text.match(/\be(\d{1,3})\b/i);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

// ============================================================
// REMOVE SEASON / EPISODE FOR TITLE COMPARISON
// ============================================================

function removeSeasonEpisode(value) {
  return normalizeTitle(value)
    .replace(/\bs\d{1,2}e\d{1,3}\b/gi, " ")
    .replace(/\bs\d{1,2}\b/gi, " ")
    .replace(/\bseason\s*\d{1,2}\b/gi, " ")
    .replace(/\bepisode\s*\d{1,3}\b/gi, " ")
    .replace(/\be\d{1,3}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// GET FILENAME / FOLDER NAME
// ============================================================

function getFileNameFromPath(path) {
  if (!path) return "";

  const clean = path.replace(/\/+$/, "");

  const parts = clean.split("/");

  return parts[parts.length - 1] || "";
}

function getParentFolderFromPath(path) {
  if (!path) return "";

  const clean = path.replace(/\/+$/, "");
  const parts = clean.split("/");

  if (parts.length < 2) return "";

  return parts[parts.length - 2] || "";
}

// ============================================================
// TITLE SIMILARITY
// ============================================================

function calculateSimilarity(query, candidate) {
  const q = tokenize(query);
  const c = tokenize(candidate);

  if (!q.length || !c.length) return 0;

  const candidateSet = new Set(c);

  let matched = 0;

  for (const token of q) {
    if (candidateSet.has(token)) {
      matched++;
    }
  }

  return matched / q.length;
}

// ============================================================
// STRONG TITLE MATCH
// ============================================================

function titleLooksLikeMatch(query, candidate) {
  const q = removeReleaseTags(query);
  const c = removeReleaseTags(candidate);

  if (!q || !c) return false;

  if (c === q) return true;

  if (c.includes(q)) return true;

  if (q.includes(c) && c.length >= 4) return true;

  const qBase = removeSeasonEpisode(q);
  const cBase = removeSeasonEpisode(c);

  if (qBase && cBase) {
    if (qBase === cBase) return true;

    if (cBase.includes(qBase)) return true;

    if (qBase.includes(cBase) && cBase.length >= 4) {
      return true;
    }
  }

  const similarity = calculateSimilarity(q, c);

  return similarity >= 0.75;
}

// ============================================================
// SCORE FILE
// ============================================================

function scoreFile(item, searchTitle, season, episode) {
  const fileName = getFileNameFromPath(item.path);
  const folderName = getParentFolderFromPath(item.path);

  const normalizedSearch = removeReleaseTags(searchTitle);

  const fileNormalized = removeReleaseTags(fileName);
  const folderNormalized = removeReleaseTags(folderName);

  let score = 0;

  // ----------------------------------------------------------
  // Exact filename title
  // ----------------------------------------------------------

  if (fileNormalized === normalizedSearch) {
    score += 100;
  }

  // ----------------------------------------------------------
  // Filename contains search title
  // ----------------------------------------------------------

  if (fileNormalized.includes(normalizedSearch)) {
    score += 80;
  }

  // ----------------------------------------------------------
  // Folder contains search title
  // ----------------------------------------------------------

  if (folderNormalized.includes(normalizedSearch)) {
    score += 70;
  }

  // ----------------------------------------------------------
  // Base title comparison
  // ----------------------------------------------------------

  const searchBase = removeSeasonEpisode(searchTitle);
  const fileBase = removeSeasonEpisode(fileName);
  const folderBase = removeSeasonEpisode(folderName);

  if (searchBase && fileBase) {
    if (fileBase === searchBase) {
      score += 80;
    } else if (fileBase.includes(searchBase)) {
      score += 60;
    }
  }

  if (searchBase && folderBase) {
    if (folderBase === searchBase) {
      score += 90;
    } else if (folderBase.includes(searchBase)) {
      score += 70;
    }
  }

  // ----------------------------------------------------------
  // Token similarity
  // ----------------------------------------------------------

  score += calculateSimilarity(searchTitle, fileName) * 40;
  score += calculateSimilarity(searchTitle, folderName) * 50;

  // ----------------------------------------------------------
  // Season
  // ----------------------------------------------------------

  const candidateSeason =
    extractSeason(fileName) ??
    extractSeason(folderName);

  if (season !== null && candidateSeason !== null) {
    if (season === candidateSeason) {
      score += 50;
    } else {
      score -= 60;
    }
  }

  // ----------------------------------------------------------
  // Episode
  // ----------------------------------------------------------

  const candidateEpisode =
    extractEpisode(fileName);

  if (episode !== null && candidateEpisode !== null) {
    if (episode === candidateEpisode) {
      score += 80;
    } else {
      score -= 100;
    }
  }

  return score;
}

// ============================================================
// SEARCH FILES
// ============================================================

function searchFiles(searchTitle, options = {}) {
  const season =
    options.season !== undefined
      ? options.season
      : extractSeason(searchTitle);

  const episode =
    options.episode !== undefined
      ? options.episode
      : extractEpisode(searchTitle);

  console.log("");
  console.log("🔎 SMART SEARCH");
  console.log(`   Query: "${searchTitle}"`);

  if (season !== null) {
    console.log(`   Season: S${String(season).padStart(2, "0")}`);
  }

  if (episode !== null) {
    console.log(`   Episode: E${String(episode).padStart(2, "0")}`);
  }

  const results = [];

  for (const item of FILE_CACHE) {
    const score = scoreFile(
      item,
      searchTitle,
      season,
      episode
    );

    if (score >= 45) {
      results.push({
        item,
        score
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  console.log(`   Candidates: ${results.length}`);

  if (results.length > 0) {
    console.log("   Top matches:");

    results.slice(0, 10).forEach((result, index) => {
      console.log(
        `   ${index + 1}. [${Math.round(result.score)}] ${result.item.title}`
      );
    });
  }

  return results.map((x) => x.item);
}

// ============================================================
// WEB-DAV SCANNER
// ============================================================

async function scanAllFiles(path = "/") {
  try {
    let cleanPath = path;

    if (!cleanPath.startsWith("/")) {
      cleanPath = "/" + cleanPath;
    }

    if (
      !cleanPath.endsWith("/") &&
      cleanPath !== "/"
    ) {
      cleanPath += "/";
    }

    const encodedPath = encodeWebDavPath(cleanPath);

    const targetUrl =
      WEBDAV_CONFIG.baseUrl.replace(/\/$/, "") +
      encodedPath;

    const response = await fetch(targetUrl, {
      method: "PROPFIND",
      headers: {
        Authorization: getAuthHeader(
          WEBDAV_CONFIG.username,
          WEBDAV_CONFIG.password
        ),
        Depth: "1",
        "Content-Type":
          "application/xml; charset=utf-8"
      },
      body: PROPFIND_XML
    });

    if (!response.ok) {
      console.error(
        `❌ PROPFIND ${response.status}: ${cleanPath}`
      );
      return;
    }

    const rawXmlText = await response.text();

    let xmlText = rawXmlText;

    try {
      xmlText = decodeURIComponent(rawXmlText);
    } catch (e) {}

    const responseRegex =
      /<[Dd]:response>([\s\S]*?)<\/[Dd]:response>/g;

    let responseMatch;

    while (
      (responseMatch = responseRegex.exec(xmlText)) !== null
    ) {
      const responseBody = responseMatch[1];

      const hrefMatch =
        /<[Dd]:href>([\s\S]*?)<\/[Dd]:href>/.exec(
          responseBody
        );

      if (!hrefMatch) continue;

      let itemPath = decodeXmlEntities(
        hrefMatch[1].trim()
      );

      try {
        itemPath = decodeURIComponent(itemPath);
      } catch (e) {}

      const decodedCurrentPath =
        decodeURIComponent(cleanPath);

      if (
        itemPath === decodedCurrentPath ||
        itemPath === decodedCurrentPath + "/" ||
        itemPath === cleanPath
      ) {
        continue;
      }

      const isFolder =
        responseBody.includes("collection/>") ||
        responseBody.includes("collection");

      // ======================================================
      // FOLDER
      // ======================================================

      if (isFolder) {
        let subPath = itemPath;

        if (subPath.startsWith("http")) {
          try {
            subPath = new URL(subPath).pathname;
          } catch (e) {}
        }

        try {
          subPath = decodeURIComponent(subPath);
        } catch (e) {}

        console.log(
          `📁 Phát hiện thư mục: ${subPath}`
        );

        await scanAllFiles(subPath);

        continue;
      }

      // ======================================================
      // FILE
      // ======================================================

      if (isVideoFile(itemPath)) {
        const displayNameMatch =
          /<[Dd]:displayname>([\s\S]*?)<\/[Dd]:displayname>/.exec(
            responseBody
          );

        let fileName = displayNameMatch
          ? decodeXmlEntities(
              displayNameMatch[1]
            )
          : getFileNameFromPath(itemPath);

        try {
          fileName = decodeURIComponent(fileName);
        } catch (e) {}

        FILE_CACHE.push({
          title: fileName,
          path: itemPath
        });
      }
    }
  } catch (error) {
    console.error(
      `❌ Lỗi quét tại ${path}:`,
      error.message
    );
  }
}

// ============================================================
// REFRESH CACHE
// ============================================================

async function refreshCache() {
  if (isScanning) {
    console.log("⚠️ Scan đang chạy.");
    return;
  }

  isScanning = true;

  FILE_CACHE = [];

  console.log("");
  console.log("========================================================");
  console.log("🔄 BẮT ĐẦU QUÉT PIKPAK");
  console.log("========================================================");

  const startTime = Date.now();

  await scanAllFiles("/");

  const elapsed =
    ((Date.now() - startTime) / 1000).toFixed(1);

  lastScanTime = new Date().toISOString();

  console.log("");
  console.log("========================================================");
  console.log(
    `✅ QUÉT HOÀN TẤT: ${FILE_CACHE.length} file video`
  );
  console.log(`⏱️ Thời gian: ${elapsed}s`);
  console.log("========================================================");

  isScanning = false;
}

// ============================================================
// CINEMETA
// ============================================================

async function getMovieMeta(imdbId, type) {
  try {
    let metaType = type;

    if (
      metaType !== "movie" &&
      metaType !== "series" &&
      metaType !== "tv"
    ) {
      metaType = "movie";
    }

    if (metaType === "tv") {
      metaType = "series";
    }

    const url =
      `https://v3-cinemeta.strem.io/meta/` +
      `${metaType}/${imdbId}.json`;

    console.log(`🌐 Cinemeta: ${url}`);

    const res = await fetch(url);

    if (!res.ok) {
      console.log(
        `⚠️ Cinemeta HTTP ${res.status}`
      );

      return null;
    }

    const data = await res.json();

    return data?.meta || null;
  } catch (error) {
    console.error(
      "❌ Cinemeta error:",
      error.message
    );

    return null;
  }
}

// ============================================================
// GENERATE SEARCH TERMS
// ============================================================

function generateSearchTerms(meta, pathName) {
  const terms = [];

  if (meta?.name) {
    terms.push(meta.name);
  }

  if (meta?.originalName) {
    terms.push(meta.originalName);
  }

  if (meta?.original_name) {
    terms.push(meta.original_name);
  }

  // Một số metadata có alternativeTitles
  if (Array.isArray(meta?.alternativeTitles)) {
    terms.push(...meta.alternativeTitles);
  }

  if (Array.isArray(meta?.aliases)) {
    terms.push(...meta.aliases);
  }

  // Loại trùng
  return [
    ...new Set(
      terms
        .filter(Boolean)
        .map((x) => String(x).trim())
        .filter((x) => x.length >= 2)
    )
  ];
}

// ============================================================
// STREAM URL
// ============================================================

function buildStreamUrl(host, item) {
  return (
    `http://${host}/proxy-stream` +
    `?path=${encodeURIComponent(item.path)}`
  );
}

// ============================================================
// SERVER
// ============================================================

const server = http.createServer(
  async (req, res) => {
    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, OPTIONS"
    );

    res.setHeader(
      "Access-Control-Allow-Headers",
      "*"
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const host =
      req.headers.host ||
      `localhost:${PORT}`;

    const parsedUrl = new URL(
      req.url,
      `http://${host}`
    );

    const pathName =
      parsedUrl.pathname;

    // ========================================================
    // MANIFEST
    // ========================================================

    if (pathName === "/manifest.json") {
      res.setHeader(
        "Content-Type",
        "application/json"
      );

      res.end(
        JSON.stringify({
          id: "com.nuvio.pikpak.webdav",
          name: "PikPak WebDAV Provider",
          version: ADDON_VERSION,
          description:
            "Provider kết nối thư viện PikPak qua WebDAV cho Nuvio",
          icon:
            "https://raw.githubusercontent.com/dungde/Davio-PikPak/main/icon.png",
          resources: ["stream"],
          types: ["movie", "tv"],
          catalogs: [],
          background: ""
        })
      );

      return;
    }

    // ========================================================
    // HEALTH
    // ========================================================

    if (pathName === "/health") {
      res.setHeader(
        "Content-Type",
        "application/json"
      );

      res.end(
        JSON.stringify({
          status: "ok",
          service: "Nuvio PikPak Provider",
          version: ADDON_VERSION,
          scanning: isScanning,
          cachedFiles: FILE_CACHE.length,
          lastScanTime
        })
      );

      return;
    }

    // ========================================================
    // DEBUG FILES
    // ========================================================

    if (pathName === "/debug/files") {
      res.setHeader(
        "Content-Type",
        "application/json"
      );

      res.end(
        JSON.stringify(
          {
            count: FILE_CACHE.length,
            scanning: isScanning,
            lastScanTime,
            files: FILE_CACHE
          },
          null,
          2
        )
      );

      return;
    }

    // ========================================================
    // MANUAL REFRESH
    // ========================================================

    if (pathName === "/refresh") {
      res.setHeader(
        "Content-Type",
        "application/json"
      );

      if (isScanning) {
        res.end(
          JSON.stringify({
            ok: false,
            message: "Scan đang chạy"
          })
        );

        return;
      }

      refreshCache();

      res.end(
        JSON.stringify({
          ok: true,
          message:
            "Đã bắt đầu refresh cache"
        })
      );

      return;
    }

    // ========================================================
    // STREAM
    // ========================================================

    if (pathName.startsWith("/stream/")) {
      res.setHeader(
        "Content-Type",
        "application/json"
      );

      // ------------------------------------------------------
      // Parse:
      //
      // /stream/movie/tt123456
      // /stream/series/tt123456
      // /stream/tv/tt123456
      // ------------------------------------------------------

      const match =
        /\/(movie|series|tv)\/(tt\d+)/i.exec(
          pathName
        );

      const requestedType =
        match ? match[1].toLowerCase() : "movie";

      const imdbId =
        match ? match[2] : "";

      console.log("");
      console.log("========================================================");
      console.log("🔍 NUVIO STREAM REQUEST");
      console.log(`   Type: ${requestedType}`);
      console.log(`   IMDb: ${imdbId}`);
      console.log("========================================================");

      if (!imdbId) {
        res.end(
          JSON.stringify({
            streams: []
          })
        );

        return;
      }

      // ------------------------------------------------------
      // CINEMETA
      // ------------------------------------------------------

      const meta =
        await getMovieMeta(
          imdbId,
          requestedType
        );

      const searchTerms =
        generateSearchTerms(
          meta,
          pathName
        );

      console.log(
        `💬 Cinemeta title: "${meta?.name || ""}"`
      );

      if (meta?.originalName) {
        console.log(
          `🎬 Original title: "${meta.originalName}"`
        );
      }

      console.log(
        `🔎 Search terms: ${JSON.stringify(searchTerms)}`
      );

      // ------------------------------------------------------
      // SEASON / EPISODE
      //
      // Nuvio có thể truyền season/episode trong query.
      // ------------------------------------------------------

      let requestedSeason = null;
      let requestedEpisode = null;

      const seasonParam =
        parsedUrl.searchParams.get("season");

      const episodeParam =
        parsedUrl.searchParams.get("episode");

      if (seasonParam) {
        const n = parseInt(
          seasonParam,
          10
        );

        if (!isNaN(n)) {
          requestedSeason = n;
        }
      }

      if (episodeParam) {
        const n = parseInt(
          episodeParam,
          10
        );

        if (!isNaN(n)) {
          requestedEpisode = n;
        }
      }

      // ------------------------------------------------------
      // SEARCH
      // ------------------------------------------------------

      let matchedMap = new Map();

      for (const term of searchTerms) {
        const results = searchFiles(
          term,
          {
            season: requestedSeason,
            episode: requestedEpisode
          }
        );

        for (const item of results) {
          if (!matchedMap.has(item.path)) {
            matchedMap.set(
              item.path,
              item
            );
          }
        }
      }

      let filtered =
        Array.from(
          matchedMap.values()
        );

      // ------------------------------------------------------
      // FALLBACK:
      //
      // Nếu Cinemeta title không match, thử lấy title
      // từ URL/query nếu có.
      // ------------------------------------------------------

      if (filtered.length === 0) {
        const possibleTitles = [
          parsedUrl.searchParams.get("title"),
          parsedUrl.searchParams.get("name"),
          parsedUrl.searchParams.get("query")
        ].filter(Boolean);

        for (const term of possibleTitles) {
          console.log(
            `🔁 Fallback search: "${term}"`
          );

          const results =
            searchFiles(term, {
              season: requestedSeason,
              episode: requestedEpisode
            });

          for (const item of results) {
            if (!matchedMap.has(item.path)) {
              matchedMap.set(
                item.path,
                item
              );
            }
          }
        }

        filtered =
          Array.from(
            matchedMap.values()
          );
      }

      // ------------------------------------------------------
      // SERIES:
      //
      // Nếu đây là series và không có season/episode cụ thể,
      // giữ các file phù hợp thay vì chỉ lấy 1 file.
      // ------------------------------------------------------

      if (
        (requestedType === "series" ||
          requestedType === "tv") &&
        filtered.length > 0
      ) {
        console.log(
          `📺 Series mode: ${filtered.length} file`
        );
      }

      console.log(
        `🎯 Matched files: ${filtered.length}`
      );

      // ------------------------------------------------------
      // NO RESULT
      // ------------------------------------------------------

      if (filtered.length === 0) {
        console.log(
          "❌ Không tìm thấy file phù hợp."
        );

        res.end(
          JSON.stringify({
            streams: []
          })
        );

        return;
      }

      // ------------------------------------------------------
      // LIMIT
      //
      // Tránh trả hàng nghìn file nếu query quá rộng.
      // ------------------------------------------------------

      const MAX_STREAMS = 50;

      filtered =
        filtered.slice(0, MAX_STREAMS);

      // ------------------------------------------------------
      // STREAMS
      // ------------------------------------------------------

      const streams =
        filtered.map((item) => ({
          name: "⚡ PikPak Direct",
          title: item.title,
          url: buildStreamUrl(
            host,
            item
          ),
          behaviorHints: {
            notSupported: false
          }
        }));

      console.log(
        `✅ Trả ${streams.length} stream cho Nuvio.`
      );

      console.log(
        "========================================================"
      );

      res.end(
        JSON.stringify({
          streams
        })
      );

      return;
    }

    // ========================================================
    // PIKPAK PROXY / REDIRECT
    // ========================================================

    if (
      pathName.startsWith(
        "/proxy-stream"
      )
    ) {
      const targetPath =
        parsedUrl.searchParams.get(
          "path"
        );

      if (!targetPath) {
        res.writeHead(400);
        res.end(
          "Missing path"
        );
        return;
      }

      let cleanPath;

      try {
        cleanPath =
          decodeURIComponent(
            targetPath
          );
      } catch (e) {
        cleanPath = targetPath;
      }

      const encodedPath =
        encodeWebDavPath(
          cleanPath
        );

      const targetUrl =
        WEBDAV_CONFIG.baseUrl.replace(
          /\/$/,
          ""
        ) + encodedPath;

      console.log("");
      console.log("========================================================");
      console.log(
        "🌊 PIKPAK DIRECT REDIRECT"
      );
      console.log(
        `📁 ${cleanPath}`
      );
      console.log(
        `🌐 ${targetUrl}`
      );
      console.log("========================================================");

      // ------------------------------------------------------
      // CLIENT RANGE
      // ------------------------------------------------------

      const range =
        req.headers["range"];

      if (range) {
        console.log(
          `⏩ Client Range: ${range}`
        );
      }

      // ------------------------------------------------------
      // REQUEST PIKPAK
      //
      // QUAN TRỌNG:
      // Chúng ta KHÔNG pipe toàn bộ video qua Render.
      //
      // Chỉ gọi WebDAV để PikPak trả HTTP 302.
      // Sau đó Render redirect Nuvio sang signed URL.
      // ------------------------------------------------------

      const pikpakHeaders = {
        Authorization:
          getAuthHeader(
            WEBDAV_CONFIG.username,
            WEBDAV_CONFIG.password
          ),

        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",

        Accept: "*/*"
      };

      if (range) {
        pikpakHeaders.Range =
          range;
      }

      const pikpakReq =
        https.get(
          targetUrl,
          {
            headers:
              pikpakHeaders
          },
          (pikpakRes) => {
            console.log(
              `⬅️ PIKPAK HTTP ${pikpakRes.statusCode}`
            );

            // ------------------------------------------------
            // PIKPAK 302
            // ------------------------------------------------

            if (
              pikpakRes.statusCode >= 300 &&
              pikpakRes.statusCode < 400 &&
              pikpakRes.headers.location
            ) {
              const signedUrl =
                pikpakRes.headers.location;

              console.log(
                `↪️ PikPak cấp download URL: ${
                  new URL(
                    signedUrl
                  ).hostname
                }`
              );

              console.log(
                "✅ Đã lấy được signed download URL."
              );

              console.log(
                `➡️ Redirect Nuvio → ${
                  new URL(
                    signedUrl
                  ).hostname
                }`
              );

              // ------------------------------------------------
              // QUAN TRỌNG:
              // Redirect trực tiếp sang PikPak CDN.
              // ------------------------------------------------

              res.writeHead(
                302,
                {
                  Location:
                    signedUrl,

                  "Cache-Control":
                    "no-cache"
                }
              );

              res.end();

              pikpakRes.resume();

              return;
            }

            // ------------------------------------------------
            // Nếu PikPak trả 200/206 thay vì 302
            //
            // Không pipe video qua Render ở đây.
            // Redirect không có thì xử lý lỗi rõ ràng.
            // ------------------------------------------------

            console.log(
              `⚠️ PikPak không trả redirect. HTTP ${pikpakRes.statusCode}`
            );

            res.writeHead(
              502,
              {
                "Content-Type":
                  "application/json"
              }
            );

            res.end(
              JSON.stringify({
                error:
                  "PikPak không trả signed download URL",
                status:
                  pikpakRes.statusCode
              })
            );

            pikpakRes.resume();
          }
        );

      // ------------------------------------------------------
      // ERROR
      // ------------------------------------------------------

      pikpakReq.on(
        "error",
        (error) => {
          console.error(
            "❌ PikPak request error:",
            error.message
          );

          if (
            !res.writableEnded
          ) {
            res.writeHead(
              502,
              {
                "Content-Type":
                  "application/json"
              }
            );

            res.end(
              JSON.stringify({
                error:
                  "PikPak request failed",
                message:
                  error.message
              })
            );
          }
        }
      );

      // ------------------------------------------------------
      // CLIENT CLOSE
      // ------------------------------------------------------

      req.on(
        "close",
        () => {
          if (
            !pikpakReq.destroyed
          ) {
            pikpakReq.destroy();
          }

          console.log(
            "🛑 Client đóng stream."
          );
        }
      );

      return;
    }

    // ========================================================
    // 404
    // ========================================================

    res.writeHead(404);
    res.end("Not Found");
  }
);

// ============================================================
// START SERVER
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("");
    console.log("========================================================");
    console.log(
      "🚀 NUVIO PIKPAK PROVIDER"
    );
    console.log("========================================================");
    console.log(
      `📡 Port: ${PORT}`
    );
    console.log(
      `📦 Version: ${ADDON_VERSION}`
    );
    console.log(
      "📡 Manifest: /manifest.json"
    );
    console.log(
      "❤️ Health: /health"
    );
    console.log(
      "📂 Debug: /debug/files"
    );
    console.log(
      "🔄 Refresh: /refresh"
    );
    console.log("========================================================");
    console.log("");

    refreshCache();
  }
); 
