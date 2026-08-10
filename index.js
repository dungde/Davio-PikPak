/**
 * Nuvio Provider - PikPak WebDAV Integration
 */

// Hàm tạo Header Authentication (Basic Auth)
function getAuthHeader(username, password) {
  const credentials = `${username}:${password}`;
  const encoded = typeof btoa !== 'undefined' 
    ? btoa(credentials) 
    : Buffer.from(credentials).toString('base64');
  return `Basic ${encoded}`;
}

// Hàm gửi request PROPFIND để đọc danh sách tệp qua WebDAV
async function fetchWebDAVFiles(baseUrl, username, password, path = "/") {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  
  try {
    const response = await fetch(url, {
      method: "PROPFIND",
      headers: {
        "Authorization": getAuthHeader(username, password),
        "Depth": "1",
        "Content-Type": "application/xml"
      }
    });

    if (!response.ok) {
      console.error(`[PikPak WebDAV] HTTP Error: ${response.status}`);
      return [];
    }

    const xmlText = await response.text();
    const streams = [];
    
    // Regex lấy thông tin file từ thẻ xml <d:href> hoặc <href>
    const hrefRegex = /<(?:d:)?href>(.*?)<\/(?:d:)?href>/g;
    let match;

    while ((match = hrefRegex.exec(xmlText)) !== null) {
      const itemPath = match[1];
      
      // Lọc các file định dạng video
      if (itemPath.match(/\.(mp4|mkv|avi|mov|m4v)$/i)) {
        const fileName = decodeURIComponent(itemPath.split('/').pop());
        const cleanBaseUrl = baseUrl.replace(/\/dav\/?$/, "");
        const streamUrl = itemPath.startsWith("http") ? itemPath : `${cleanBaseUrl}${itemPath}`;

        streams.push({
          name: "PikPak Direct",
          title: `[PikPak] ${fileName}`,
          url: streamUrl,
          quality: "Direct",
          behaviorHints: {
            notSupported: false
          }
        });
      }
    }

    return streams;
  } catch (error) {
    console.error("[PikPak WebDAV] Fetch Exception:", error);
    return [];
  }
}

/**
 * Hàm lấy Stream dành riêng cho Nuvio Framework
 */
async function getStreams(args) {
  const { type, id } = args;

  // ĐIỀN THÔNG TIN TÀI KHOẢN CỦA BẠN TRỰC TIẾP TẠI ĐÂY:
  const webdavUrl = "http://127.0.0.1:3000/dav"; // Hoặc IP local chạy pikpak-webdav bridge
  const username = " rioh6986@gmail.com"; 
  const password = " Rio@1234567";

  console.log(`[PikPak WebDAV] Đang tìm kiếm media cho ID: ${id}, Type: ${type}`);
  
  const streams = await fetchWebDAVFiles(webdavUrl, username, password, "/");

  return {
    streams: streams
  };
}
