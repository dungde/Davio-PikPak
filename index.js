const http = require("http");
const https = require("https");

// ============================================================
// PIKPAK CONFIGURATION
// ============================================================
//
// Giai đoạn TEST:
//   Nhập trực tiếp username/password tại đây.
//
// Sau này:
//   Có thể chuyển sang /config mà không cần thay đổi phần
//   WebDAV, scanning, stream và redirect bên dưới.
//
// Nếu chạy GitHub PUBLIC, không nên commit password thật.
// ============================================================

const CONFIG = {
  pikpak: {
    username: "nbmu",
    password: "agwtnmaq",
    baseUrl: "https://dav.mypikpak.com"
  },

  server: {
    // Render tự cung cấp process.env.PORT
    // Local sẽ sử dụng 3000 nếu PORT không tồn tại.
    port: Number(process.env.PORT) || 3000
  },

  addon: {
    id: "com.nuvio.pikpak.webdav",
    name: "PikPak WebDAV Provider",
    version: "1.0.0"
  }
};


// ============================================================
// AUTH
// ============================================================

function getAuthHeader(username, password) {
  return `Basic ${Buffer.from(
    `${username}:${password}`,
    "latin1"
  ).toString("base64")}`;
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
// HELPER
// ============================================================

function pikpakBaseUrl() {
  return CONFIG.pikpak.baseUrl.replace(/\/$/, "");
}


function encodePath(path) {
  return path
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
}


function normalizePath(path) {
  let cleanPath = path || "/";

  if (!cleanPath.startsWith("/")) {
    cleanPath = "/" + cleanPath;
  }

  if (!cleanPath.endsWith("/") && cleanPath !== "/") {
    cleanPath += "/";
  }

  return cleanPath;
}


// ============================================================
// SCAN PIKPAK
// ============================================================

async function scanAllFiles(path = "/") {
  try {
    const cleanPath = normalizePath(path);

    const targetUrl =
      pikpakBaseUrl() + encodePath(cleanPath);

    console.log(`📂 SCAN: ${cleanPath}`);

    const response = await fetch(targetUrl, {
      method: "PROPFIND",
      headers: {
        "Authorization": getAuthHeader(
          CONFIG.pikpak.username,
          CONFIG.pikpak.password
        ),
        "Depth": "1",
        "Content-Type": "application/xml; charset=utf-8"
      },
      body: PROPFIND_XML
    });

    if (!response.ok) {
      console.error(
        `❌ PROPFIND ${response.status}: ${targetUrl}`
      );
      return;
    }

    const rawXmlText = await response.text();

    let xmlText = rawXmlText;

    // Một số WebDAV response có thể chứa encoded content.
    try {
      xmlText = decodeURIComponent(rawXmlText);
    } catch (_) {
      // Giữ nguyên nếu không decode được.
    }

    const responseRegex =
      /<[Dd]:response>([\s\S]*?)<\/[Dd]:response>/g;

    let responseMatch;

    while ((responseMatch = responseRegex.exec(xmlText)) !== null) {
      const responseBody = responseMatch[1];

      const hrefMatch =
        /<[Dd]:href>(.*?)<\/[Dd]:href>/.exec(responseBody);

      if (!hrefMatch) {
        continue;
      }

      let itemPath = hrefMatch[1];

      try {
        itemPath = decodeURIComponent(itemPath);
      } catch (_) {}

      let currentPath = cleanPath;

      try {
        currentPath = decodeURIComponent(cleanPath);
      } catch (_) {}

      // Bỏ qua chính folder hiện tại.
      if (
        itemPath === currentPath ||
        itemPath === currentPath + "/" ||
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
          } catch (_) {}
        }

        console.log(`   📁 Folder: ${subPath}`);

        await scanAllFiles(subPath);

      } else if (
        /\.(mp4|mkv|avi|mov|m3u8)$/i.test(itemPath)
      ) {

        const displayNameMatch =
          /<[Dd]:displayname>(.*?)<\/[Dd]:displayname>/
            .exec(responseBody);

        const fileName =
          displayNameMatch
            ? displayNameMatch[1]
            : itemPath.split("/").pop();

        FILE_CACHE.push({
          title: fileName,
          path: hrefMatch[1]
        });

        console.log(
          `${FILE_CACHE.length}. ${fileName}`
        );
      }
    }

  } catch (error) {
    console.error(
      `❌ Lỗi scan tại ${path}:`,
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

  const seconds =
    ((Date.now() - startTime) / 1000).toFixed(1);

  console.log("");
  console.log("========================================================");
  console.log(
    `✅ QUÉT HOÀN TẤT: ${FILE_CACHE.length} file video`
  );
  console.log(`⏱️ Thời gian: ${seconds}s`);
  console.log("========================================================");
  console.log("");

  isScanning = false;
}


// ============================================================
// CINEMETA
// ============================================================

async function getMovieTitleFromMeta(imdbId) {

  try {

    const type =
      imdbId.startsWith("tt")
        ? "movie"
        : "series";

    const url =
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;

    console.log(`🌐 Cinemeta: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      return "";
    }

    const data = await response.json();

    return data?.meta?.name || "";

  } catch (error) {

    console.error(
      "❌ Cinemeta error:",
      error.message
    );

    return "";
  }
}


// ============================================================
// FIND MOVIE
// ============================================================

function findMatchingFiles(title) {

  if (!title) {
    return [];
  }

  const keyword =
    title
      .toLowerCase()
      .trim();

  return FILE_CACHE.filter(file =>
    file.title
      .toLowerCase()
      .includes(keyword)
  );
}


// ============================================================
// MANIFEST
// ============================================================

function getManifest() {

  return {
    id: CONFIG.addon.id,

    name: CONFIG.addon.name,

    version: CONFIG.addon.version,

    description:
      "Provider kết nối thư viện PikPak qua WebDAV cho Nuvio.",

    icon:
      "https://raw.githubusercontent.com/dungde/Davio-PikPak/main/icon.png",

    resources: [
      "stream"
    ],

    types: [
      "movie",
      "series"
    ],

    idPrefixes: [
      "tt"
    ],

    catalogs: []
  };
}


// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(
  async (req, res) => {

    // --------------------------------------------------------
    // CORS
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // URL
    // --------------------------------------------------------

    const host =
      req.headers.host ||
      `localhost:${CONFIG.server.port}`;

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

    if (pathName === "/manifest.json") {

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      res.end(
        JSON.stringify(
          getManifest(),
          null,
          2
        )
      );

      return;
    }


    // ========================================================
    // HEALTH
    // ========================================================

    if (pathName === "/health") {

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      res.end(
        JSON.stringify({
          status: "ok",
          service: "Nuvio PikPak Provider",
          version: CONFIG.addon.version,
          scanning: isScanning,
          cachedFiles: FILE_CACHE.length
        })
      );

      return;
    }


    // ========================================================
    // DEBUG FILE LIST
    // ========================================================

    if (pathName === "/debug/files") {

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      res.end(
        JSON.stringify({
          count: FILE_CACHE.length,
          scanning: isScanning,
          files: FILE_CACHE
        })
      );

      return;
    }


    // ========================================================
    // MANUAL REFRESH
    // ========================================================

    if (pathName === "/refresh") {

      if (isScanning) {

        res.setHeader(
          "Content-Type",
          "application/json; charset=utf-8"
        );

        res.end(
          JSON.stringify({
            status: "already_scanning"
          })
        );

        return;
      }

      // Không chặn HTTP request trong lúc scan.
      refreshCache();

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      res.end(
        JSON.stringify({
          status: "scan_started"
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
        "application/json; charset=utf-8"
      );

      // Hỗ trợ:
      //
      // /stream/movie/tt0499549.json
      // /stream/movie/tt0499549
      //
      const match =
        /\/(movie|series|tv)\/(tt\d+)/i
          .exec(pathName);

      let imdbId = "";
      let searchKeyword = "";

      if (match) {

        imdbId = match[2];

        console.log("");
        console.log("========================================================");
        console.log("🔍 NUVIO STREAM REQUEST");
        console.log(`Type: ${match[1]}`);
        console.log(`IMDb: ${imdbId}`);
        console.log("========================================================");

        searchKeyword =
          await getMovieTitleFromMeta(imdbId);

        console.log(
          `💬 Cinemeta title: "${searchKeyword}"`
        );
      }

      if (!imdbId) {

        res.end(
          JSON.stringify({
            streams: []
          })
        );

        return;
      }


      // ------------------------------------------------------
      // FIND MATCH
      // ------------------------------------------------------

      let filtered =
        findMatchingFiles(searchKeyword);

      console.log(
        `🎯 Matched files: ${filtered.length}`
      );


      // ------------------------------------------------------
      // FALLBACK
      // ------------------------------------------------------

      if (
        filtered.length === 0 &&
        searchKeyword
      ) {

        const normalized =
          searchKeyword
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "");

        filtered =
          FILE_CACHE.filter(file => {

            const fileNormalized =
              file.title
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "");

            return fileNormalized.includes(normalized);
          });

        console.log(
          `🔎 Normalized fallback: ${filtered.length}`
        );
      }


      // ------------------------------------------------------
      // RETURN STREAMS
      // ------------------------------------------------------

      const streams =
        filtered.map(
          (item) => {

            const streamUrl =
              `http://${host}/proxy-stream?path=` +
              encodeURIComponent(item.path);

            return {

              name:
                "⚡ PikPak",

              title:
                item.title,

              url:
                streamUrl,

              behaviorHints: {
                notSupported: false
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
      pathName === "/proxy-stream" ||
      pathName.startsWith("/proxy-stream/")
    ) {

      const targetPath =
        parsedUrl.searchParams.get("path");

      if (!targetPath) {

        res.writeHead(400);

        res.end(
          "Missing path"
        );

        return;
      }


      let cleanPath =
        targetPath;

      try {
        cleanPath =
          decodeURIComponent(targetPath);
      } catch (_) {}


      const encodedPath =
        encodePath(cleanPath);

      const targetUrl =
        pikpakBaseUrl() +
        encodedPath;


      console.log("");
      console.log("========================================================");
      console.log("🌊 PIKPAK DIRECT REDIRECT");
      console.log(`📁 ${cleanPath}`);
      console.log(`🌐 ${targetUrl}`);
      console.log("========================================================");


      const pikpakHeaders = {

        "Authorization":
          getAuthHeader(
            CONFIG.pikpak.username,
            CONFIG.pikpak.password
          ),

        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 " +
          "(KHTML, like Gecko) " +
          "Chrome/120 Safari/537.36",

        "Accept":
          "*/*"
      };


      // ------------------------------------------------------
      // RANGE
      // ------------------------------------------------------

      if (req.headers.range) {

        pikpakHeaders.range =
          req.headers.range;

        console.log(
          `⏩ Client Range: ${req.headers.range}`
        );
      }


      // ------------------------------------------------------
      // REQUEST PIKPAK
      // ------------------------------------------------------

      const pikpakReq =
        https.get(
          targetUrl,
          {
            headers: pikpakHeaders
          },
          (pikpakRes) => {

            console.log(
              `⬅️ PIKPAK HTTP ${pikpakRes.statusCode}`
            );


            // ------------------------------------------------
            // REDIRECT
            // ------------------------------------------------

            if (
              pikpakRes.statusCode >= 300 &&
              pikpakRes.statusCode < 400 &&
              pikpakRes.headers.location
            ) {

              const signedUrl =
                pikpakRes.headers.location;

              console.log(
                `↪️ REDIRECT → ${signedUrl.substring(
                  0,
                  100
                )}...`
              );

              console.log(
                "✅ Đã lấy được signed download URL."
              );

              // ------------------------------------------------
              // QUAN TRỌNG:
              // Redirect trực tiếp cho Nuvio/player.
              //
              // Không pipe video qua Render.
              // ------------------------------------------------

              res.writeHead(
                302,
                {
                  "Location":
                    signedUrl,

                  "Cache-Control":
                    "no-cache",

                  "Access-Control-Allow-Origin":
                    "*"
                }
              );

              res.end();

              pikpakRes.resume();

              return;
            }


            // ------------------------------------------------
            // Nếu PikPak trả 200 trực tiếp
            // ------------------------------------------------

            const responseHeaders = {};

            if (
              pikpakRes.headers["content-type"]
            ) {

              responseHeaders[
                "Content-Type"
              ] =
                pikpakRes.headers[
                  "content-type"
                ];
            }

            if (
              pikpakRes.headers["content-length"]
            ) {

              responseHeaders[
                "Content-Length"
              ] =
                pikpakRes.headers[
                  "content-length"
                ];
            }

            if (
              pikpakRes.headers["content-range"]
            ) {

              responseHeaders[
                "Content-Range"
              ] =
                pikpakRes.headers[
                  "content-range"
                ];
            }

            responseHeaders[
              "Accept-Ranges"
            ] = "bytes";


            res.writeHead(
              pikpakRes.statusCode || 200,
              responseHeaders
            );

            pikpakRes.pipe(res);
          }
        );


      // ------------------------------------------------------
      // REQUEST ERROR
      // ------------------------------------------------------

      pikpakReq.on(
        "error",
        (error) => {

          console.error(
            "❌ PikPak request error:",
            error.message
          );

          if (
            !res.headersSent &&
            !res.writableEnded
          ) {

            res.writeHead(502);

            res.end(
              "PikPak connection error"
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

            console.log(
              "🛑 Client đóng stream."
            );
          }
        }
      );

      return;
    }


    // ========================================================
    // 404
    // ========================================================

    res.writeHead(404);

    res.end(
      "Not Found"
    );
  }
);


// ============================================================
// START SERVER
// ============================================================

server.listen(
  CONFIG.server.port,
  "0.0.0.0",
  () => {

    console.log("");
    console.log("========================================================");
    console.log("🚀 NUVIO PIKPAK PROVIDER");
    console.log("========================================================");
    console.log(
      `🌐 Port: ${CONFIG.server.port}`
    );
    console.log(
      `📡 Manifest: /manifest.json`
    );
    console.log(
      `❤️ Health: /health`
    );
    console.log(
      `📂 Debug: /debug/files`
    );
    console.log(
      `🔄 Refresh: /refresh`
    );
    console.log("========================================================");
    console.log("");
    console.log(
      "🔄 Bắt đầu scan thư viện PikPak..."
    );

    refreshCache();
  }
);