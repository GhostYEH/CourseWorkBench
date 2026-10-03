/** Pure boundary checks shared by the Electron request hook and its tests. */
const shouldAttachRendererSession = (details, windowId, origin) => {
  if (!details || details.webContentsId !== windowId || !origin) return false;
  let requestOrigin;
  try {
    requestOrigin = new URL(details.url).origin;
  } catch {
    return false;
  }
  if (requestOrigin !== origin) return false;
  if (details.frame) return details.frame.parent === null;
  // Electron can omit `frame` for the initial top-level navigation. Its
  // resourceType still identifies the request, and webContentsId binds it.
  return details.resourceType === 'mainFrame';
};

const rendererRequestHeaders = (details, windowId, origin, sessionToken, requestHeaders) => {
  if (!sessionToken || !shouldAttachRendererSession(details, windowId, origin)) return requestHeaders;
  return { ...requestHeaders, 'x-sew-session': sessionToken };
};

module.exports = { shouldAttachRendererSession, rendererRequestHeaders };
