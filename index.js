const http = require("http");
const https = require("https");

// ============================================================
// PIKPAK CONFIG
// ============================================================

const PIKPAK_CONFIG = {
  baseUrl: "https://dav.mypikpak.com",

  // Nhập tài khoản PikPak hiện tại của bạn
  username: "nbmu",
  password: "agwtnmaq"
};

// ============================================================
// SERVER
// ============================================================

const PORT = process.env.PORT || 10000;

// ============================================================
// BASIC AUTH
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
// NORMALIZE TEXT
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

// ============================================================
// COMPACT TEXT
// ============================================================

function compactText(text) {
  return normalizeText(text).replace(/\s+/g, "");
}

// ============================================================
// TOKENIZE
// ============================================================

function getWords(text) {
  return normalizeText(text)
    .split(" ")
    .filter(word => word.length >= 2);
}

// ============================================================
// EXTRACT SEASON / EPISODE
// ============================================================

function extractSeasonEpisode(text) {
  if (!text) return null;

  const patterns = [
    /\bS(\d{1,2})E(\d{1,3})\b/i,
    /\bS(\d{1,2})[\s._-]+E(\d{1,3})\b/i,
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i
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

  const seasonOnly =
    /\bS(\d{1,2})\b/i.exec(text);

  if (seasonOnly) {
    return {
      season: parseInt(seasonOnly[1], 10),
      episode: null
    };
  }

  return null;
}

// ============================================================
// CLEAN TITLE
// ============================================================

function cleanTitle(text) {
  if (!text) return "";

  let value = text;

  // Extension
  value = value.replace(
    /\.(mkv|mp4|avi|mov|m3u8)$/i,
    ""
  );

  // Season / episode
  value = value.replace(
    /\bS\d{1,2}(?:E\d{1,3})?\b/gi,
    " "
  );

  // Season xx
  value = value.replace(
    /\bSeason[\s._-]*\d{1,2}\b/gi,
    " "
  );

  // Quality / release information
  value = value.replace(
    /\b(?:2160p|1080p|720p|480p|4k|uhd)\b/gi,
    " "
  );

  value = value.replace(
    /\b(?:web-dl|webdl|webrip|web|bluray|blu-ray|brrip|br-rip|hdtv|remux)\b/gi,
    " "
  );

  value = value.replace(
    /\b(?:x264|x265|h264|h265|hevc|avc|10bit|8bit)\b/gi,
    " "
  );

  value = value.replace(
    /\b(?:aac|ac3|ddp|dd5\.1|dts|atmos)\b/gi,
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
// Đây là phần QUAN TRỌNG NHẤT.
//
// Không chỉ dựa vào S01E03.
// Tên phim phải match trước.
// ============================================================

function titleMatches(fileText, requestedTitle) {
  const requested = cleanTitle(requestedTitle);

  if (!requested) {
    return false;
  }

  const file = cleanTitle(fileText);

  if (!file) {
    return false;
  }

  const requestedCompact =
    compactText(requested);

  const fileCompact =
    compactText(file);

  // Exact
  if (fileCompact === requestedCompact) {
    return true;
  }

  // Toàn bộ title xuất hiện trong file
  if (
    requestedCompact.length >= 4 &&
    fileCompact.includes(requestedCompact)
  ) {
    return true;
  }

  // Kiểm tra từng từ quan trọng
  const words = getWords(requested);

  if (!words.length) {
    return false;
  }

  let matched = 0;

  for (const word of words) {
    if (file.includes(word)) {
      matched++;
    }
  }

  /*
   * Với title nhiều từ:
   * phải match phần lớn các từ.
   *
   * Ví dụ:
   * "My Youth"
   *
   * My     -> có
   * Youth  -> có
   *
   * => 2/2 => OK
   *
   * "House of the Dragon"
   *
   * My     -> không
   * Youth  -> không
   *
   * => loại.
   */

  const ratio =
    matched / words.length;

  if (words.length === 1) {
    return matched === 1;
  }

  return ratio >= 0.75;
}

// ============================================================
// FIND MOVIE
// ============================================================

function findMovieFiles(title) {
  if (!title) {
    return [];
  }

  const results = [];

  for (const file of FILE_CACHE) {
    /*
     * Movie vẫn dùng title matching.
     *
     * Kiểm tra cả title và path để hỗ trợ:
     *
     * /Avatar (2009)/Avatar.2009.mkv
     */

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
// FIND SERIES / EPISODE
// ============================================================

function findSeriesFiles(
  title,
  season,
  episode
) {
  if (!title) {
    return [];
  }

  const results = [];

  for (const file of FILE_CACHE) {

    /*
     * ========================================================
     * BƯỚC 1
     *
     * TÊN PHIM PHẢI KHỚP.
     *
     * Đây là điều kiện bắt buộc.
     *
     * Nếu title không match:
     *
     * return / continue
     *
     * ngay lập tức.
     *
     * Vì vậy:
     *
     * My Youth
     * +
     * House of the Dragon S01E03
     *
     * sẽ bị loại ở đây.
     * ========================================================
     */

    const searchText =
      `${file.title} ${file.path}`;

    if (
      !titleMatches(
        searchText,
        title
      )
    ) {
      continue;
    }

    /*
     * ========================================================
     * BƯỚC 2
     *
     * Kiểm tra Season / Episode
     * ========================================================
     */

    const se =
      extractSeasonEpisode(
        searchText
      );

    /*
     * Nếu request có Season
     * thì file phải đúng Season.
     */

    if (season != null) {

      if (!se) {
        /*
         * Không nhận diện được season.
         *
         * Không trả file mơ hồ.
         */
        continue;
      }

      if (se.season !== season) {
        continue;
      }
    }

    /*
     * Nếu request có Episode
     * thì file phải có đúng Episode.
     */

    if (episode != null) {

      if (!se) {
        continue;
      }

      if (se.episode !== episode) {
        continue;
      }
    }

    /*
     * Tới đây mới được coi là MATCH.
     */

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

    if (!cleanPath.startsWith("/")) {
      cleanPath = "/" + cleanPath;
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
      xmlText = rawXml;
    }

    const responseRegex =
      /<[Dd]:response>([\s\S]*?)<\/[Dd]:response>/g;

    let match;

    while (
      (match =
        responseRegex.exec(xmlText)) !== null
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
              (segment, index) =>
                index === 0
                  ? segment
                  : encodeURIComponent(
                      segment
                    )
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
      data?.meta ||
      null
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
  // Ví dụ:
  //
  // tt1234567:1:1
  //
  // IMDb: tt1234567
  // Season: 1
  // Episode: 1
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

  const encoded =
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
    ) + encoded
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

      /*
       * Nếu client tua phim,
       * chuyển Range sang PikPak.
       */

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
            // 302 → SIGNED URL
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

              resolve(
                signedUrl
              );

              response.resume();

              return;
            }

            // =================================================
            // 200
            // =================================================

            if (
              response.statusCode === 200
            ) {

              resolve(
                targetUrl
              );

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

      request.on(
        "timeout",
        () => {

          request.destroy(
            new Error(
              "PikPak timeout"
            )
          );
        }
      );

      request.on(
        "error",
        reject
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
      // HEALTH
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
          `Files: ${FILE_CACHE.length}\n`
        );

        return;
      }

      // ========================================================
      // STREAM
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
          `📌 URL: ${req.url}`
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
            "❌ Không parse được request"
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
          requestInfo.season != null
        ) {

          console.log(
            `📺 Season: ${requestInfo.season}`
          );
        }

        if (
          requestInfo.episode != null
        ) {

          console.log(
            `▶️ Episode: ${requestInfo.episode}`
          );
        }

        // ======================================================
        // CINEM
