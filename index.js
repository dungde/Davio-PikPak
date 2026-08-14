const http = require("http");
const https = require("https");

// ============================================================
// PIKPAK CONFIG
// ============================================================

const PIKPAK_CONFIG = {
  baseUrl: "https://dav.mypikpak.com",

  // ==========================================================
  // NHẬP TÀI KHOẢN PIKPAK CỦA BẠN TẠI ĐÂY
  // ==========================================================

  username: "nbmu",
  password: " agwtnmaq"
};

// ============================================================
// RENDER PORT
// ============================================================

const PORT = process.env.PORT || 10000;

// ============================================================
// WEBDAV XML
// ============================================================

const PROPFIND_XML = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

// ============================================================
// CACHE
// ============================================================

let FILE_CACHE = [];
let isScanning = false;

// ============================================================
// AUTH
// ============================================================

function getAuthHeader(username, password) {
  return (
    "Basic " +
    Buffer.from(
      `${username}:${password}`,
      "latin1"
    ).toString("base64")
  );
}

// ============================================================
// NORMALIZE TEXT
// ============================================================

function normalizeText(text) {
  if (!text) return "";

  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[._()[\]{}'"!?,:+\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// COMPACT TEXT
// ============================================================

function compactText(text) {
  return normalizeText(text).replace(/\s+/g, "");
}

// ============================================================
// EXTRACT SEASON / EPISODE
// ============================================================

function extractSeasonEpisode(text) {
  if (!text) return null;

  let match = text.match(
    /\bS(\d{1,2})E(\d{1,3})\b/i
  );

  if (match) {
    return {
      season: parseInt(match[1], 10),
      episode: parseInt(match[2], 10)
    };
  }

  match = text.match(
    /\bS(\d{1,2})[\s._-]+E(\d{1,3})\b/i
  );

  if (match) {
    return {
      season: parseInt(match[1], 10),
      episode: parseInt(match[2], 10)
    };
  }

  match = text.match(
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i
  );

  if (match) {
    return {
      season: parseInt(match[1], 10),
      episode: parseInt(match[2], 10)
    };
  }

  match = text.match(
    /\bS(\d{1,2})\b/i
  );

  if (match) {
    return {
      season: parseInt(match[1], 10),
      episode: null
    };
  }

  return null;
}

// ============================================================
// CLEAN RELEASE NAME
// ============================================================

function cleanTitle(text) {
  if (!text) return "";

  let value = text;

  // Extension
  value = value.replace(
    /\.(mkv|mp4|avi|mov|m3u8)$/i,
    ""
  );

  // Season / Episode
  value = value.replace(
    /\bS\d{1,2}E\d{1,3}\b/gi,
    " "
  );

  value = value.replace(
    /\bS\d{1,2}\b/gi,
    " "
  );

  // Season 1 / Season 2...
  value = value.replace(
    /\bSeason[\s._-]*\d{1,2}\b/gi,
    " "
  );

  // Quality
  value = value.replace(
    /\b2160p\b/gi,
    " "
  );

  value = value.replace(
    /\b1080p\b/gi,
    " "
  );

  value = value.replace(
    /\b720p\b/gi,
    " "
  );

  value = value.replace(
    /\b480p\b/gi,
    " "
  );

  value = value.replace(
    /\b4K\b/gi,
    " "
  );

  // Release types
  value = value.replace(
    /\bWEB[- ]?DL\b/gi,
    " "
  );

  value = value.replace(
    /\bWEB[- ]?RIP\b/gi,
    " "
  );

  value = value.replace(
    /\bBlu[- ]?Ray\b/gi,
    " "
  );

  value = value.replace(
    /\bBRRip\b/gi,
    " "
  );

  value = value.replace(
    /\bRemux\b/gi,
    " "
  );

  value = value.replace(
    /\bHDTV\b/gi,
    " "
  );

  // Video codecs
  value = value.replace(
    /\bH\.?264\b/gi,
    " "
  );

  value = value.replace(
    /\bH\.?265\b/gi,
    " "
  );

  value = value.replace(
    /\bX264\b/gi,
    " "
  );

  value = value.replace(
    /\bX265\b/gi,
    " "
  );

  value = value.replace(
    /\bHEVC\b/gi,
    " "
  );

  value = value.replace(
    /\bAVC\b/gi,
    " "
  );

  value = value.replace(
    /\b10bit\b/gi,
    " "
  );

  value = value.replace(
    /\b8bit\b/gi,
    " "
  );

  // Audio
  value = value.replace(
    /\bAAC\d?(?:\.\d+)?\b/gi,
    " "
  );

  value = value.replace(
    /\bDDP\d?(?:\.\d+)?\b/gi,
    " "
  );

  value = value.replace(
    /\bDD\d?(?:\.\d+)?\b/gi,
    " "
  );

  value = value.replace(
    /\bDTS(?:[- ]?HD)?\b/gi,
    " "
  );

  value = value.replace(
    /\bAtmos\b/gi,
    " "
  );

  // Year
  value = value.replace(
    /\b(?:19|20)\d{2}\b/g,
    " "
  );

  return normalizeText(value);
}

// ============================================================
// TITLE MATCH
//
// Tên phim là điều kiện bắt buộc.
// Không bao giờ match chỉ dựa vào S01E03.
// ============================================================

function titleMatches(searchText, requestedTitle) {
  if (!searchText || !requestedTitle) {
    return false;
  }

  const requested =
    cleanTitle(requestedTitle);

  const file =
    cleanTitle(searchText);

  if (!requested || !file) {
    return false;
  }

  const requestedCompact =
    compactText(requested);

  const fileCompact =
    compactText(file);

  // Exact
  if (
    requestedCompact ===
    fileCompact
  ) {
    return true;
  }

  // Full title contained in filename/path
  if (
    requestedCompact.length >= 4 &&
    fileCompact.includes(requestedCompact)
  ) {
    return true;
  }

  // Word based matching
  const words =
    requested.split(" ")
      .filter(
        word => word.length >= 2
      );

  if (!words.length) {
    return false;
  }

  let matched = 0;

  for (const word of words) {
    if (file.includes(word)) {
      matched++;
    }
  }

  if (words.length === 1) {
    return matched === 1;
  }

  const ratio =
    matched / words.length;

  return ratio >= 0.75;
}

// ============================================================
// MOVIE SEARCH
// ============================================================

function findMovieFiles(title) {
  const results = [];

  for (const file of FILE_CACHE) {
    const searchText =
      `${file.title} ${file.path}`;

    if (
      titleMatches(
        searchText,
        title
      )
    ) {
      results.push(file);
    }
  }

  return results;
}

// ============================================================
// SERIES SEARCH
// ============================================================

function findSeriesFiles(
  title,
  season,
  episode
) {
  const results = [];

  for (const file of FILE_CACHE) {

    const searchText =
      `${file.title} ${file.path}`;

    // ========================================================
    // STEP 1:
    // TÊN PHIM PHẢI KHỚP
    // ========================================================

    if (
      !titleMatches(
        searchText,
        title
      )
    ) {
      continue;
    }

    // ========================================================
    // STEP 2:
    // SEASON / EPISODE
    // ========================================================

    const se =
      extractSeasonEpisode(
        searchText
      );

    if (season != null) {

      if (!se) {
        continue;
      }

      if (
        se.season !== season
      ) {
        continue;
      }
    }

    if (episode != null) {

      if (!se) {
        continue;
      }

      if (
        se.episode !== episode
      ) {
        continue;
      }
    }

    results.push(file);
  }

  return results;
}

// ============================================================
// SCAN PIKPAK
// ============================================================

async function scanAllFiles(path = "/") {
  try {

    let cleanPath = path;

    if (
      !cleanPath.startsWith("/")
    ) {
      cleanPath =
        "/" + cleanPath;
    }

    if (
      !cleanPath.endsWith("/") &&
      cleanPath !== "/"
    ) {
      cleanPath += "/";
    }

    const targetUrl =
      PIKPAK_CONFIG.baseUrl.replace(
        /\/$/,
        ""
      ) + cleanPath;

    const response =
      await fetch(
        targetUrl,
        {
          method: "PROPFIND",

          headers: {
            Authorization:
              getAuthHeader(
                PIKPAK_CONFIG.username,
                PIKPAK_CONFIG.password
              ),

            Depth: "1",

            "Content-Type":
              "application/xml; charset=utf-8"
          },

          body: PROPFIND_XML
        }
      );

    if (!response.ok) {

      console.error(
        `❌ PROPFIND ${cleanPath} → HTTP ${response.status}`
      );

      return;
    }

    const rawXml =
      await response.text();

    let xmlText;

    try {
      xmlText =
        decodeURIComponent(
          rawXml
        );
    } catch {
      xmlText =
        rawXml;
    }

    const responseRegex =
      /<[Dd]:response>([\s\S]*?)<\/[Dd]:response>/g;

    let match;

    while (
      (match =
        responseRegex.exec(
          xmlText
        )) !== null
    ) {

      const responseBody =
        match[1];

      const hrefMatch =
        /<[Dd]:href>(.*?)<\/[Dd]:href>/
          .exec(responseBody);

      if (!hrefMatch) {
        continue;
      }

      let itemPath =
        hrefMatch[1];

      try {
        itemPath =
          decodeURIComponent(
            itemPath
          );
      } catch {}

      const currentPath =
        decodeURIComponent(
          cleanPath
        );

      if (
        itemPath === currentPath ||
        itemPath ===
          currentPath + "/" ||
        itemPath === cleanPath
      ) {
        continue;
      }

      const isFolder =
        responseBody.includes(
          "collection"
        );

      // ======================================================
      // FOLDER
      // ======================================================

      if (isFolder) {

        let subPath =
          itemPath;

        if (
          subPath.startsWith(
            "http"
          )
        ) {
          try {
            subPath =
              new URL(
                subPath
              ).pathname;
          } catch {}
        }

        console.log(
          `📁 Phát hiện thư mục: ${subPath}`
        );

        const nextPath =
          subPath
            .split("/")
            .map(
              (segment, index) => {
                if (index === 0) {
                  return segment;
                }

                return encodeURIComponent(
                  segment
                );
              }
            )
            .join("/");

        await scanAllFiles(
          nextPath
        );

        continue;
      }

      // ======================================================
      // VIDEO FILE
      // ======================================================

      if (
        /\.(mp4|mkv|avi|mov|m3u8)$/i.test(
          itemPath
        )
      ) {

        const displayNameMatch =
          /<[Dd]:displayname>(.*?)<\/[Dd]:displayname>/
            .exec(responseBody);

        const fileName =
          displayNameMatch
            ? displayNameMatch[1]
            : itemPath
                .split("/")
                .pop();

        FILE_CACHE.push({
          title: fileName,
          path: itemPath
        });
      }
    }

  } catch (error) {

    console.error(
      `❌ Lỗi quét ${path}: ${error.message}`
    );
  }
}

// ============================================================
// REFRESH CACHE
// ============================================================

async function refreshCache() {

  if (isScanning) {
    return;
  }

  isScanning = true;

  FILE_CACHE = [];

  const start =
    Date.now();

  console.log("");
  console.log(
    "========================================================"
  );
  console.log(
    "🔄 BẮT ĐẦU QUÉT PIKPAK"
  );
  console.log(
    "========================================================"
  );

  await scanAllFiles("/");

  const seconds =
    (
      (Date.now() - start) /
      1000
    ).toFixed(1);

  console.log("");
  console.log(
    "========================================================"
  );
  console.log(
    `✅ QUÉT HOÀN TẤT: ${FILE_CACHE.length} file video`
  );
  console.log(
    `⏱️ Thời gian: ${seconds}s`
  );
  console.log(
    "========================================================"
  );
  console.log("");

  isScanning = false;
}

// ============================================================
// CINEMETA
// ============================================================

async function getCinemetaMeta(
  type,
  imdbId
) {
  try {

    let metaType =
      type === "tv"
        ? "series"
        : type;

    if (
      metaType !== "movie" &&
      metaType !== "series"
    ) {
      metaType = "movie";
    }

    const url =
      `https://v3-cinemeta.strem.io/meta/` +
      `${metaType}/${imdbId}.json`;

    console.log(
      `🌐 Cinemeta: ${url}`
    );

    const response =
      await fetch(url);

    if (!response.ok) {

      console.log(
        `⚠️ Cinemeta HTTP ${response.status}`
      );

      return null;
    }

    const data =
      await response.json();

    return (
      data &&
      data.meta
        ? data.meta
        : null
    );

  } catch (error) {

    console.error(
      `❌ Cinemeta error: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// PARSE STREAM REQUEST
// ============================================================

function parseStreamRequest(
  pathName
) {

  const match =
    pathName.match(
      /^\/stream\/(movie|series|tv)\/([^/]+?)(?:\.json)?$/i
    );

  if (!match) {
    return null;
  }

  const type =
    match[1].toLowerCase();

  const rawId =
    decodeURIComponent(
      match[2]
    );

  // ==========================================================
  // MOVIE
  // ==========================================================

  if (type === "movie") {

    return {
      type: "movie",
      imdbId: rawId,
      season: null,
      episode: null
    };
  }

  // ==========================================================
  // SERIES
  //
  // Hỗ trợ:
  //
  // tt1234567:1:3
  //
  // = IMDb + Season + Episode
  // ==========================================================

  const seriesMatch =
    /^(tt\d+)(?::(\d+))?(?::(\d+))?$/i
      .exec(rawId);

  if (seriesMatch) {

    return {
      type: "series",

      imdbId:
        seriesMatch[1],

      season:
        seriesMatch[2]
          ? parseInt(
              seriesMatch[2],
              10
            )
          : null,

      episode:
        seriesMatch[3]
          ? parseInt(
              seriesMatch[3],
              10
            )
          : null
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
// BUILD PIKPAK URL
// ============================================================

function buildPikPakUrl(
  filePath
) {

  const cleanPath =
    filePath.startsWith("/")
      ? filePath
      : "/" + filePath;

  const encodedPath =
    cleanPath
      .split("/")
      .map(
        (segment, index) => {

          if (index === 0) {
            return "";
          }

          return encodeURIComponent(
            segment
          );
        }
      )
      .join("/");

  return (
    PIKPAK_CONFIG.baseUrl.replace(
      /\/$/,
      ""
    ) + encodedPath
  );
}

// ============================================================
// GET SIGNED URL
// ============================================================

function getSignedUrl(
  targetUrl,
  rangeHeader
) {

  return new Promise(
    (resolve, reject) => {

      const headers = {
        Authorization:
          getAuthHeader(
            PIKPAK_CONFIG.username,
            PIKPAK_CONFIG.password
          ),

        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",

        Accept: "*/*"
      };

      if (rangeHeader) {

        headers.Range =
          rangeHeader;

        console.log(
          `⏩ Client Range: ${rangeHeader}`
        );
      }

      console.log(
        `🌐 PikPak request: ${targetUrl}`
      );

      const request =
        https.get(
          targetUrl,
          {
            headers,
            timeout: 30000
          },
          response => {

            console.log(
              `⬅️ PIKPAK HTTP ${response.statusCode}`
            );

            // =================================================
            // PIKPAK 302
            // =================================================

            if (
              response.statusCode >= 300 &&
              response.statusCode < 400 &&
              response.headers.location
            ) {

              const signedUrl =
                response.headers.location;

              try {

                console.log(
                  `↪️ Redirect → ${new URL(signedUrl).hostname}`
                );

              } catch {}

              response.resume();

              resolve(
                signedUrl
              );

              return;
            }

            // =================================================
            // PIKPAK 200
            // =================================================

            if (
              response.statusCode === 200
            ) {

              response.resume();

              resolve(
                targetUrl
              );

              return;
            }

            response.resume();

            reject(
              new Error(
                `PikPak HTTP ${response.statusCode}`
              )
            );
          }
        );

      request.on(
        "timeout",
        () => {

          request.destroy(
            new Error(
              "PikPak request timeout"
            )
          );
        }
      );

      request.on(
        "error",
        error => {
          reject(error);
        }
      );
    }
  );
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
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

      if (
        req.method ===
        "OPTIONS"
      ) {

        res.writeHead(204);
        res.end();

        return;
      }

      const host =
        req.headers.host ||
        `localhost:${PORT}`;

      const parsedUrl =
        new URL(
          req.url,
          `http://${host}`
        );

      const pathName =
        parsedUrl.pathname;

      // ========================================================
      // MANIFEST
      // ========================================================

      if (
        pathName ===
        "/manifest.json"
      ) {

        res.setHeader(
          "Content-Type",
          "application/json"
        );

        res.end(
          JSON.stringify({
            id:
              "com.nuvio.pikpak.webdav",

            name:
              "PikPak WebDAV Provider",

            version:
              "1.0.0",

            description:
              "Provider kết nối thư viện PikPak qua WebDAV cho Nuvio",

            resources: [
              "stream"
            ],

            types: [
              "movie",
              "series"
            ],

            catalogs: []
          })
        );

        return;
      }

      // ========================================================
      // HEALTH CHECK
      // ========================================================

      if (
        pathName === "/" ||
        pathName === "/health"
      ) {

        res.setHeader(
          "Content-Type",
          "text/plain; charset=utf-8"
        );

        res.end(
          "Nuvio PikPak Provider OK\n" +
          `Cached files: ${FILE_CACHE.length}\n`
        );

        return;
      }

      // ========================================================
      // STREAM REQUEST
      // ========================================================

      if (
        pathName.startsWith(
          "/stream/"
        )
      ) {

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
          `📌 Request: ${req.url}`
        );
        console.log(
          "========================================================"
        );

        const requestInfo =
          parseStreamRequest(
            pathName
          );

        if (!requestInfo) {

          console.log(
            "❌ Không parse được stream request."
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

        if (
          requestInfo.season !== null
        ) {

          console.log(
            `📺 Season: ${requestInfo.season}`
          );
        }

        if (
          requestInfo.episode !== null
        ) {

          console.log(
            `▶️ Episode: ${requestInfo.episode}`
          );
        }

        // ======================================================
        // CINEMETA
        // ======================================================

        const meta =
          await getCinemetaMeta(
            requestInfo.type,
            requestInfo.imdbId
          );

        const title =
          meta &&
          (
            meta.name ||
            meta.title
          )
            ? (
                meta.name ||
                meta.title
              )
            : "";

        console.log(
          `💬 Cinemeta title: "${title}"`
        );

        // ======================================================
        // SEARCH
        // ======================================================

        let matchedFiles = [];

        if (
          requestInfo.type ===
          "movie"
        ) {

          matchedFiles =
            findMovieFiles(
              title
            );

        } else {

          matchedFiles =
            findSeriesFiles(
              title,
              requestInfo.season,
              requestInfo.episode
            );
        }

        console.log(
          `🎯 Matched files: ${matchedFiles.length}`
        );

        // ======================================================
        // SHOW MATCHED FILES
        // ======================================================

        if (
          matchedFiles.length > 0
        ) {

          matchedFiles
            .slice(0, 20)
            .forEach(
              (file, index) => {

                console.log(
                  `${index + 1}. ${file.path}`
                );
              }
            );

        } else {

          console.log(
            "❌ Không tìm thấy file phù hợp."
          );
        }

        // ======================================================
        // BUILD STREAMS
        // ======================================================

        const streams =
          matchedFiles.map(
            file => {

              return {
                name:
                  "⚡ PikPak",

                title:
                  file.title,

                url:
                  `http://${host}` +
                  `/pikpak?path=` +
                  encodeURIComponent(
                    file.path
                  ),

                behaviorHints: {
                  notWebReady:
                    false,

                  bingeGroup:
                    requestInfo.imdbId
                }
              };
            }
          );

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
      // PIKPAK DIRECT REDIRECT
      // ========================================================

      if (
        pathName ===
        "/pikpak"
      ) {

        const targetPath =
          parsedUrl.searchParams.get(
            "path"
          );

        if (!targetPath) {

          res.writeHead(
            400
          );

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

          cleanPath =
            targetPath;
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

        try {

          const signedUrl =
            await getSignedUrl(
              targetUrl,
              rangeHeader
            );

          console.log(
            "✅ Đã lấy được signed download URL."
          );

          try {

            console.log(
              `➡️ Redirect Nuvio → ${new URL(signedUrl).hostname}`
            );

          } catch {}

          res.writeHead(
            302,
            {
              Location:
                signedUrl,

              "Cache-Control":
                "no-store, no-cache, must-revalidate"
            }
          );

          res.end();

          return;

        } catch (error) {

          console.error(
            `❌ Signed URL error: ${error.message}`
          );

          if (
            !res.writableEnded
          ) {

            res.writeHead(
              502
            );

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

      res.writeHead(
        404
      );

      res.end(
        "Not found"
      );
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
      `🌐 PORT: ${PORT}`
    );
    console.log(
      "🎬 Movie + Series + Episode"
    );
    console.log(
      "🔎 Strict title matching"
    );
    console.log(
      "⚡ PikPak Signed URL Redirect"
    );
    console.log(
      "========================================================"
    );
    console.log("");

    refreshCache();
  }
);
