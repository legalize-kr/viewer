if (chrome.action?.onClicked && chrome.tabs?.create) {
  chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
  });
}

const attachmentProxyPath = "/__legalize_attachment__";

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function attachmentUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("지원하지 않는 첨부 URL입니다.");
  }
  return url;
}

async function fetchAttachmentPayload(urlValue) {
  const url = attachmentUrl(urlValue);
  const response = await fetch(url.toString(), { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`첨부 파일을 불러오지 못했습니다. (${response.status})`);
  }
  return {
    contentType: response.headers.get("content-type") || "application/octet-stream",
    contentDisposition: response.headers.get("content-disposition") || "",
    buffer: await response.arrayBuffer()
  };
}

async function fetchAttachment(urlValue) {
  const payload = await fetchAttachmentPayload(urlValue);
  return {
    ok: true,
    contentType: payload.contentType,
    contentDisposition: payload.contentDisposition,
    data: arrayBufferToBase64(payload.buffer)
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fetch-attachment") return false;
  fetchAttachment(message.url)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function attachmentProxyUrl(requestUrl) {
  const url = new URL(requestUrl);
  const extensionUrl = new URL(chrome.runtime.getURL(""));
  if (url.protocol !== extensionUrl.protocol || url.host !== extensionUrl.host || url.pathname !== attachmentProxyPath) return "";
  return url.searchParams.get("url") || "";
}

self.addEventListener("fetch", (event) => {
  const urlValue = attachmentProxyUrl(event.request.url);
  if (!urlValue) return;
  event.respondWith(
    fetchAttachmentPayload(urlValue)
      .then((payload) => {
        const headers = new Headers({ "content-type": payload.contentType });
        if (payload.contentDisposition) headers.set("x-content-disposition", payload.contentDisposition);
        return new Response(payload.buffer, { headers });
      })
      .catch((error) => new Response(error.message, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }))
  );
});
