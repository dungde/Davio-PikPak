const http = require("http");
const https = require("https");

// ============================================================
// PIKPAK CONFIG
// ============================================================
// Tạm thời nhập trực tiếp username/password.
// Sau này có thể chuyển sang process.env hoặc /config mà
// không cần thay đổi phần xử lý stream.
//
// ============================================================

const PIKPAK_CONFIG = {
  baseUrl: "https://dav.mypikpak.com",
  username: "nbmu",
  password: "agwtnmaq"
};

// ============================================================
// SERVER CONFIG
// ============================================================

const PORT = process.env.PORT || 10000;

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
// WEBDAV
// ============================================================

const PROPFIND_XML = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

let FILE_CACHE = [];
let isScanning = false;

// ============================================================
// TEXT NORMALIZATION
// ============================================================

function normalizeText(text) {
  if (!text) return "";

  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[._\-()[\]{}'":,!?+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(text) {
  return normalizeText(text).replace(/\s+/g, "");
}

// ============================================================
// CLEAN MOVIE / SERIES NAME
// ============================================================

function cleanMediaName(name) {
  if (!name) return "";

  let s = name;

  // Remove extension
  s = s.replace(/\.(mkv|mp4|avi|mov|m3u8)$/i, "");

  // Remove season/episode markers
  s = s.replace(
    /\bS\d{1,2}(?:E\d{1,3}(?:[-E]\d{1,3})?)?\b/gi,
    " "
  );

  // Remove common release tags / quality information
  s = s.replace(
    /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr|dv|dolby|vision|bluray|blu-ray|web-dl|webdl|webrip|web|brrip|br-rip|hdtv|remux|x264|x265|h264|h265|hevc|avc|aac|ac3|ddp|dd5\.1|dts|atmos)\b/gi,
    " "
  );

  s = s.replace(/\b(?:19|20)\d{2}\b/g, " ");

  return normalizeText(s);
}

// ============================================================
// EXTRACT SEASON / EPISODE
// ============================================================

function extractSeasonEpisode(text) {
  if (!text) return null;

  const patterns = [
    /\bS(\d{1,2})E(\d{1,3})\b/i,
    /\bS(\d{1,2})[\s._-]+E(\d{1,3})\b/i,
    /\bSEASON[\s._-]*(\d{1,2})[\s._-]*EP(?:ISODE)?[\s._-]*(\d{1,3})\b/i
  ];

  for (const regex of patterns) {
    const match = regex.exec(text);

    if (match) {
      return {
        season: parseInt(match[1], 10),
        episode: parseInt(match[2], 10)
      };
    }
  }

  // S01 only
  const seasonOnly = /\bS(\d{1,2})\b/i.exec(text);

  if (seasonOnly) {
    return {
      season: parseInt(seasonOnly[1], 10),
      episode: null
    };
  }

  return null;
}

// ============================================================
// SCAN PIKPAK
// ============================================================

async function scanAllFiles(path = "/") {
  try {
    let cleanPath = path;

    if (!cleanPath.startsWith("/")) {
      cleanPath = "/" + cleanPath;
    }

    if (!cleanPath.endsWith("/") && cleanPath !== "/") {
      cleanPath += "/";
    }

    const targetUrl =
      PIKPAK_CONFIG.baseUrl.replace(/\/$/, "") + cleanPath;

    console.log(`📂 Scan: ${cleanPath}`);

    const response = await fetch(targetUrl, {
      method: "PROPFIND",
      headers: {
        Authorization: getAuthHeader(
          PIKPAK_CONFIG.username,
          PIKPAK_CONFIG.password
        ),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8"
      },
      body: PROPFIND_XML
    });

    if (!response.ok) {
      console.error(
        `❌ PROPFIND ${cleanPath}: HTTP ${response.status}`
      );
      return;
    }

    const rawXmlText = await response.text();

    let xmlText;

    try {
      xmlText = decodeURIComponent(rawXmlText);
    } catch {
      xmlText = rawXmlText;
    }

    const responseRegex =
      /<[Dd]:response>([\s\S]*?)<\/[Dd]:response>/g;

    let responseMatch;

    while ((responseMatch = responseRegex.exec(xmlText)) !== null) {
      const responseBody = responseMatch[1];

      const hrefMatch =
        /<[Dd]:href>(.*?)<\/[Dd]:href>/.exec(responseBody);

      if (!hrefMatch) continue;

      let itemPath = hrefMatch[1];

      try {
        itemPath = decodeURIComponent(itemPath);
      } catch {}

      const decodedCurrentPath = decodeURIComponent(cleanPath);

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

      if (isFolder) {
        let subPath = itemPath;

        if (subPath.startsWith("http")) {
          try {
            subPath = new URL(subPath).pathname;
          } catch {}
        }

        console.log(`   📁 Phát hiện thư mục: ${subPath}`);

        const nextPath = subPath
          .split("/")
          .map((part, index) =>
            index === 0 ? part : encodeURIComponent(part)
          )
          .join("/");

        await scanAllFiles(nextPath);
      } else if (
        /\.(mp4|mkv|avi|mov|m3u8)$/i.test(itemPath)
      ) {
        const displayNameMatch =
          /<[Dd]:displayname>(.*?)<\/[Dd]:displayname>/.exec(
            responseBody
          );

        const fileName = displayNameMatch
          ? displayNameMatch[1]
          : itemPath.split("/").pop();

        FILE_CACHE.push({
          title: fileName,
          path: itemPath
        });
      }
    }
  } catch (error) {
    console.error(
      `❌ Lỗi quét tại ${path}: ${error.message}`
    );
  }
}

// ============================================================
// REFRESH CACHE
// ============================================================

async function refreshCache() {
  if (isScanning) {
    console.log("⚠️ Đang quét, bỏ qua yêu cầu scan mới.");
    return;
  }

  isScanning = true;
  FILE_CACHE = [];

  const start = Date.now();

  console.log("");
  console.log("========================================================");
  console.log("🔄 BẮT ĐẦU QUÉT PIKPAK");
  console.log("========================================================");

  await scanAllFiles("/");

  const elapsed =
    ((Date.now() - start) / 1000).toFixed(1);

  console.log("");
  console.log("========================================================");
  console.log(`✅ QUÉT HOÀN TẤT: ${FILE_CACHE.length} file video`);
  console.log(`⏱️ Thời gian: ${elapsed}s`);
  console.log("========================================================");
  console.log("");

  isScanning = false;
}

// ============================================================
// CINEMETA
// ============================================================

async function getCinemetaMeta(type, imdbId) {
  try {
    let cinemetaType = type;

    if (cinemetaType === "tv") {
      cinemetaType = "series";
    }

    if (cinemetaType !== "movie" && cinemetaType !== "series") {
      cinemetaType = "movie";
    }

    const url =
      `https://v3-cinemeta.strem.io/meta/` +
      `${cinemetaType}/${imdbId}.json`;

    console.log(`🌐 Cinemeta: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      console.log(
        `⚠️ Cinemeta HTTP ${response.status}`
      );
      return null;
    }

    const data = await response.json();

    return data?.meta || null;
  } catch (error) {
    console.error(
      `❌ Cinemeta error: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// EXTRACT STREAM REQUEST
// ============================================================

function parseStreamRequest(pathName) {
  const match = pathName.match(
    /^\/stream\/(movie|series|tv)\/([^/]+?)(?:\.json)?$/i
  );

  if (!match) return null;

  const type = match[1].toLowerCase();
  const rawId = decodeURIComponent(match[2]);

  // ----------------------------------------------------------
  // MOVIE
  // ----------------------------------------------------------

  if (type === "movie") {
    return {
      type: "movie",
      imdbId: rawId,
      season: null,
      episode: null
    };
  }

  // ----------------------------------------------------------
  // SERIES
  //
  // Stremio style:
  //
  // tt1234567:1:1
  // tt1234567:1:2
  // ----------------------------------------------------------

  const seriesMatch =
    /^(tt\d+)(?::(\d+))?(?::(\d+))?$/i.exec(rawId);

  if (seriesMatch) {
    return {
      type: "series",
      imdbId: seriesMatch[1],
      season: seriesMatch[2]
        ? parseInt(seriesMatch[2], 10)
        : null,
      episode: seriesMatch[3]
        ? parseInt(seriesMatch[3], 10)
        : null
    };
  }

  // Một số client có thể gửi dạng:
  // tt1234567:1:1:...
  const looseMatch =
    /^(tt\d+):(\d+):(\d+)/i.exec(rawId);

  if (looseMatch) {
    return {
      type: "series",
      imdbId: looseMatch[1],
      season: parseInt(looseMatch[2], 10),
      episode: parseInt(looseMatch[3], 10)
    };
  }

  return {
    type: "series",
    imdbId: rawId,
    season: null,
    episode: null
  };
}

// ============================================================
// SCORE MOVIE
// ============================================================

function scoreMovie(file, title) {
  const fileBase = cleanMediaName(file.title);
  const queryBase = cleanMediaName(title);

  if (!fileBase || !queryBase) {
    return 0;
  }

  const compactFile = compactText(fileBase);
  const compactQuery = compactText(queryBase);

  if (
    compactFile === compactQuery
  ) {
    return 100;
  }

  if (
    compactFile.includes(compactQuery) ||
    compactQuery.includes(compactFile)
  ) {
    return 80;
  }

  const queryWords = queryBase
    .split(" ")
    .filter(w => w.length >= 2);

  if (!queryWords.length) return 0;

  let hits = 0;

  for (const word of queryWords) {
    if (fileBase.includes(word)) {
      hits++;
    }
  }

  return Math.round(
    (hits / queryWords.length) * 70
  );
}

// ============================================================
// SCORE SERIES
// ============================================================

function scoreSeries(file, title, season, episode) {
  const fileText = normalizeText(file.title);
  const titleText = normalizeText(title);

  const fileCompact = compactText(file.title);
  const titleCompact = compactText(title);

  let score = 0;

  // ----------------------------------------------------------
  // TITLE
  // ----------------------------------------------------------

  if (
    fileCompact.includes(titleCompact) ||
    titleCompact.includes(fileCompact)
  ) {
    score += 60;
  } else {
    const words = titleText
      .split(" ")
      .filter(w => w.length >= 2);

    let hits = 0;

    for (const word of words) {
      if (fileText.includes(word)) {
        hits++;
      }
    }

    if (words.length) {
      score += Math.round(
        (hits / words.length) * 50
      );
    }
  }

  // ----------------------------------------------------------
  // SEASON / EPISODE
  // ----------------------------------------------------------

  const se = extractSeasonEpisode(file.title);

  if (season != null) {
    if (se && se.season === season) {
      score += 25;
    } else if (!se) {
      // Không có S01 trong tên file.
      // Không cộng điểm nhưng cũng không loại ngay.
    } else {
      score -= 50;
    }
  }

  if (episode != null) {
    if (
      se &&
      se.episode === episode
    ) {
      score += 50;
    } else if (
      se &&
      se.episode !== episode
    ) {
      score -= 70;
    }
  }

  return score;
}

// ============================================================
// FIND MOVIE
// ============================================================

function findMovieFiles(title) {
  if (!title) return [];

  const scored = FILE_CACHE
    .map(file => ({
      file,
      score: scoreMovie(file, title)
    }))
    .filter(item => item.score >= 45)
    .sort((a, b) => b.score - a.score);

  return scored.map(item => item.file);
}

// ============================================================
// FIND SERIES
// ============================================================

function findSeriesFiles(title, season, episode) {
  if (!title) return [];

  const scored = FILE_CACHE
    .map(file => ({
      file,
      score: scoreSeries(
        file,
        title,
        season,
        episode
      )
    }))
    .filter(item => item.score >= 40)
    .sort((a, b) => b.score - a.score);

  return scored.map(item => item.file);
}

// ============================================================
// CREATE SIGNED PIKPAK URL
// ============================================================

function buildPikPakUrl(filePath) {
  const cleanPath =
    filePath.startsWith("/")
      ? filePath
      : "/" + filePath;

  const encodedPath = cleanPath
    .split("/")
    .map((segment, index) => {
      if (index === 0) return "";
      return encodeURIComponent(segment);
    })
    .join("/");

  return (
    PIKPAK_CONFIG.baseUrl.replace(/\/$/, "") +
    encodedPath
  );
}

// ============================================================
// GET SIGNED URL FROM PIKPAK
// ============================================================

function getSignedUrl(targetUrl, rangeHeader) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: getAuthHeader(
        PIKPAK_CONFIG.username,
        PIKPAK_CONFIG.password
      ),
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "*/*"
    };

    if (rangeHeader) {
      headers.Range = rangeHeader;
    }

    console.log(`🌐 PikPak request: ${targetUrl}`);

    const request = https.get(
      targetUrl,
      {
        headers,
        timeout: 30000
      },
      response => {
        console.log(
          `⬅️ PIKPAK HTTP ${response.statusCode}`
        );

        // PikPak trả signed download URL
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          const signedUrl =
            response.headers.location;

          console.log(
            `↪️ PikPak cấp download URL: ${new URL(signedUrl).hostname}`
          );

          resolve(signedUrl);

          response.resume();
          return;
        }

        // Một số trường hợp có thể trả thẳng 200
        if (response.statusCode === 200) {
          resolve(targetUrl);
          response.resume();
          return;
        }

        reject(
          new Error(
            `PikPak HTTP ${response.statusCode}`
          )
        );

        response.resume();
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error("PikPak request timeout")
      );
    });

    request.on("error", reject);
  });
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
          version: "1.0.0",
          description:
            "Provider kết nối thư viện PikPak qua WebDAV cho Nuvio",
          resources: ["stream"],
          types: ["movie", "series"],
          catalogs: []
        })
      );

      return;
    }

    // ========================================================
    // HEALTH CHECK
    // ========================================================

    if (pathName === "/" || pathName === "/health") {
      res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      res.end(
        `Nuvio PikPak Provider OK\nFiles: ${FILE_CACHE.length}\n`
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

      console.log("");
      console.log(
        "========================================================"
      );
      console.log(
        "🔍 NUVIO STREAM REQUEST"
      );
      console.log(
        `📌 URL: ${req.url}`
      );
      console.log(
        "========================================================"
      );

      const requestInfo =
        parseStreamRequest(pathName);

      if (!requestInfo) {
        console.log(
          "❌ Không parse được stream request"
        );

        res.end(
          JSON.stringify({
            streams: []
          })
        );

        return;
      }

      console.log(
        `🎬 Type: ${requestInfo.type}`
      );

      console.log(
        `🆔 IMDb: ${requestInfo.imdbId}`
      );

      if (requestInfo.season != null) {
        console.log(
          `📺 Season: ${requestInfo.season}`
        );
      }

      if (requestInfo.episode != null) {
        console.log(
          `▶️ Episode: ${requestInfo.episode}`
        );
      }

      // ------------------------------------------------------
      // CINEMETA
      // ------------------------------------------------------

      const meta =
        await getCinemetaMeta(
          requestInfo.type,
          requestInfo.imdbId
        );

      const title =
        meta?.name ||
        meta?.title ||
        "";

      console.log(
        `💬 Cinemeta title: "${title}"`
      );

      // ------------------------------------------------------
      // FIND FILES
      // ------------------------------------------------------

      let matchedFiles = [];

      if (
        requestInfo.type === "movie"
      ) {
        matchedFiles =
          findMovieFiles(title);

        console.log(
          `🎯 Movie matched: ${matchedFiles.length}`
        );
      } else {
        matchedFiles =
          findSeriesFiles(
            title,
            requestInfo.season,
            requestInfo.episode
          );

        console.log(
          `🎯 Series matched: ${matchedFiles.length}`
        );
      }

      // ------------------------------------------------------
      // FALLBACK:
      // Nếu series có season nhưng không tìm thấy episode
      // chính xác, tìm theo title + season.
      // ------------------------------------------------------

      if (
        matchedFiles.length === 0 &&
        requestInfo.type === "series" &&
        requestInfo.season != null
      ) {
        console.log(
          "🔄 Không tìm thấy episode chính xác."
        );

        console.log(
          "🔄 Fallback: tìm theo title + season."
        );

        matchedFiles =
          FILE_CACHE
            .map(file => ({
              file,
              score: scoreSeries(
                file,
                title,
                requestInfo.season,
                null
              )
            }))
            .filter(item => item.score >= 45)
            .sort(
              (a, b) =>
                b.score - a.score
            )
            .map(item => item.file);

        console.log(
          `🎯 Season fallback: ${matchedFiles.length}`
        );
      }

      // ------------------------------------------------------
      // CREATE STREAMS
      // ------------------------------------------------------

      const streams =
        matchedFiles.map(file => {
          const targetUrl =
            buildPikPakUrl(file.path);

          return {
            name: "⚡ PikPak",
            title: file.title,

            // Direct redirect endpoint.
            url:
              `http://${host}` +
              `/pikpak?path=` +
              encodeURIComponent(
                file.path
              ),

            behaviorHints: {
              notWebReady: false,
              bingeGroup:
                requestInfo.imdbId
            }
          };
        });

      console.log(
        `✅ Trả ${streams.length} stream cho Nuvio.`
      );

      console.log(
        "========================================================"
      );
      console.log("");

      res.end(
        JSON.stringify({
          streams
        })
      );

      return;
    }

    // ========================================================
    // PIKPAK SIGNED URL REDIRECT
    // ========================================================

    if (pathName === "/pikpak") {
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
      } catch {
        cleanPath = targetPath;
      }

      const targetUrl =
        buildPikPakUrl(
          cleanPath
        );

      console.log("");
      console.log(
        "========================================================"
      );

      console.log(
        "🌊 PIKPAK DIRECT REDIRECT"
      );

      console.log(
        `📁 ${cleanPath}`
      );

      console.log(
        `🌐 ${targetUrl}`
      );

      console.log(
        "========================================================"
      );

      const rangeHeader =
        req.headers.range ||
        null;

      if (rangeHeader) {
        console.log(
          `⏩ Client Range: ${rangeHeader}`
        );
      }

      try {
        const signedUrl =
          await getSignedUrl(
            targetUrl,
            rangeHeader
          );

        console.log(
          "✅ Đã lấy được signed download URL."
        );

        console.log(
          `➡️ Redirect Nuvio → ${new URL(signedUrl).hostname}`
        );

        res.writeHead(
          302,
          {
            Location: signedUrl,
            "Cache-Control":
              "no-store, no-cache, must-revalidate"
          }
        );

        res.end();

        return;
      } catch (error) {
        console.error(
          `❌ Không lấy được signed URL: ${error.message}`
        );

        if (!res.writableEnded) {
          res.writeHead(502);
          res.end(
            "PikPak signed URL error"
          );
        }

        return;
      }
    }

    // ========================================================
    // 404
    // ========================================================

    res.writeHead(404);
    res.end("Not found");
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
    console.log(
      "========================================================"
    );
    console.log(
      "🚀 NUVIO PIKPAK PROVIDER"
    );
    console.log(
      `🌐 Port: ${PORT}`
    );
    console.log(
      "🎬 Movie + Series/Episode support"
    );
    console.log(
      "⚡ PikPak Signed URL Direct Redirect"
    );
    console.log(
      "========================================================"
    );
    console.log("");

    refreshCache();
  }
);

// ============================================================
// OPTIONAL PERIODIC RESCAN
// ============================================================
// Không bắt buộc.
// Nếu muốn addon tự cập nhật thư viện PikPak mỗi 30 phút,
// bỏ comment dòng bên dưới.
//
// setInterval(refreshCache, 30 * 60 * 1000);
// ============================================================
