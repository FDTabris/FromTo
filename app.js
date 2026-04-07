const { DateTime, FixedOffsetZone } = luxon;

const BASE_PATH = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname.replace(/\/[^\/]*$/, '/') || '/';
const EVENT_FILE = `${BASE_PATH}events.csv`;
const PIC_DIR = `${BASE_PATH}pic`;
const PIC_MANIFEST_FILE = `${PIC_DIR}/manifest.json`;
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
const USER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const state = {
  events: [],
  activeIndex: 0,
  activeTag: "All",
  timerId: null,
  imageCache: new Map(),
  imageResolvePromises: new Map(),
  imageManifestSet: new Set(),
  isImageManifestLoaded: false,
  lastImageEventKey: null,
  isSidebarOpen: false,
  scrollLockY: 0,
  isInitialLoad: true,
};

function parseUrlPath() {
  const path = window.location.pathname;
  if (path.startsWith(BASE_PATH)) {
    const relativePath = path.slice(BASE_PATH.length);
    const match = relativePath.match(/^event\/(\d+)$/);
    return match ? match[1] : null;
  }
  return null;
}

function getEventIndexById(eventId) {
  if (!eventId) return 0;
  const index = state.events.findIndex(event => event.id === eventId);
  return index >= 0 ? index : 0;
}

function navigateToEvent(eventId) {
  const path = eventId ? `${BASE_PATH}event/${eventId}` : BASE_PATH;
  if (window.location.pathname !== path) {
    window.history.pushState({ eventId }, '', path);
  }
  const index = getEventIndexById(eventId);
  setActiveEvent(index, false); // Don't update URL since we just set it
}

const el = {
  shareButton: document.getElementById("share-button"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  sidebarClose: document.getElementById("sidebar-close"),
  sidebar: document.getElementById("event-sidebar"),
  overlay: document.getElementById("sidebar-overlay"),
  tagFilterButtons: document.getElementById("tag-filter-buttons"),
  list: document.getElementById("event-list"),
  loading: document.getElementById("loading"),
  empty: document.getElementById("empty-state"),
  detail: document.getElementById("event-detail"),
  description: document.getElementById("event-description"),
  imageWrap: document.getElementById("event-image-wrap"),
  image: document.getElementById("event-image"),
  localTime: document.getElementById("event-local-time"),
  metricMain: document.getElementById("metric-main"),
};

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Unable to create image blob."));
    }, "image/png");
  });
}

function downloadSnapshot(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(blobUrl);
}

function isLikelyIPhoneChrome() {
  const ua = navigator.userAgent || "";
  return /iPhone/i.test(ua) && /CriOS/i.test(ua);
}

function showSnapshotPreviewOverlay(imageUrl, filename, onClose) {
  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "9999";
  overlay.style.background = "rgba(10, 16, 26, 0.92)";
  overlay.style.display = "flex";
  overlay.style.flexDirection = "column";
  overlay.style.padding = "12px";
  overlay.style.gap = "10px";

  const toolbar = document.createElement("div");
  toolbar.style.display = "flex";
  toolbar.style.justifyContent = "space-between";
  toolbar.style.alignItems = "center";
  toolbar.style.gap = "8px";

  const hint = document.createElement("p");
  hint.textContent = "Long-press image to share or save";
  hint.style.margin = "0";
  hint.style.fontSize = "14px";
  hint.style.color = "#e8f0fb";

  const controls = document.createElement("div");
  controls.style.display = "flex";
  controls.style.gap = "8px";

  const openButton = document.createElement("a");
  openButton.href = imageUrl;
  openButton.target = "_blank";
  openButton.rel = "noopener";
  openButton.textContent = "Open";
  openButton.style.color = "#e8f0fb";
  openButton.style.border = "1px solid #99b5d8";
  openButton.style.borderRadius = "8px";
  openButton.style.padding = "6px 10px";
  openButton.style.textDecoration = "none";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.style.border = "1px solid #99b5d8";
  closeButton.style.background = "transparent";
  closeButton.style.color = "#e8f0fb";
  closeButton.style.borderRadius = "8px";
  closeButton.style.padding = "6px 10px";
  closeButton.style.cursor = "pointer";

  controls.append(openButton, closeButton);
  toolbar.append(hint, controls);

  const image = document.createElement("img");
  image.src = imageUrl;
  image.alt = filename;
  image.style.width = "100%";
  image.style.height = "100%";
  image.style.objectFit = "contain";
  image.style.flex = "1";
  image.style.borderRadius = "10px";
  image.style.background = "#111";
  image.style.userSelect = "none";
  image.style.webkitUserSelect = "none";

  const cleanup = () => {
    overlay.remove();
    if (typeof onClose === "function") {
      onClose();
    }
    document.removeEventListener("keydown", handleEsc);
  };

  const handleEsc = (event) => {
    if (event.key === "Escape") {
      cleanup();
    }
  };

  closeButton.addEventListener("click", cleanup);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      cleanup();
    }
  });

  overlay.append(toolbar, image);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", handleEsc);
}

function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = String(text || "").split(/\n+/).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
      }
      line = word;
    }
    if (line) {
      lines.push(line);
    }
  }
  return lines.length > 0 ? lines : [""];
}

function loadImageForCanvas(imageUrl) {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.decoding = "sync";
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

async function buildShareCanvas() {
  const detailRoot = el.detail;
  if (!detailRoot || detailRoot.classList.contains("hidden")) {
    return null;
  }

  const phraseText = (el.metricMain && el.metricMain.innerText ? el.metricMain.innerText : "").trim();
  const descriptionText = (el.description && el.description.textContent ? el.description.textContent : "").trim();
  const timeText = (el.localTime && el.localTime.textContent ? el.localTime.textContent : "").trim();
  if (!phraseText || !timeText) {
    return null;
  }

  let eventImage = null;
  const hasVisibleImage = el.imageWrap && !el.imageWrap.classList.contains("hidden") && el.image;
  if (hasVisibleImage) {
    const imageUrl = el.image.currentSrc || el.image.src || "";
    eventImage = await loadImageForCanvas(imageUrl);
  }

  const width = 1080;
  const outerPadding = 44;
  const panelPadding = 34;
  const cardPadding = 24;
  const sectionGap = 22;
  const contentWidth = width - outerPadding * 2 - panelPadding * 2;
  const phraseLineHeight = 58;
  const descriptionLineHeight = 38;
  const timeLineHeight = 42;
  const imageMaxHeight = 600;
  const imageCardPadding = 16;

  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d");
  if (!measureCtx) {
    return null;
  }

  measureCtx.font = '700 48px "Segoe UI", Arial, sans-serif';
  const phraseLines = wrapCanvasText(measureCtx, phraseText, contentWidth - cardPadding * 2);
  measureCtx.font = '500 30px "Segoe UI", Arial, sans-serif';
  const descriptionLines = descriptionText ? wrapCanvasText(measureCtx, descriptionText, contentWidth - cardPadding * 2) : [];
  measureCtx.font = '700 34px "Segoe UI", Arial, sans-serif';
  const timeLines = wrapCanvasText(measureCtx, timeText, contentWidth - cardPadding * 2);

  let drawImageWidth = 0;
  let drawImageHeight = 0;
  if (eventImage) {
    const maxImageWidth = contentWidth - imageCardPadding * 2;
    const imageScale = Math.min(maxImageWidth / eventImage.width, imageMaxHeight / eventImage.height, 1);
    drawImageWidth = Math.round(eventImage.width * imageScale);
    drawImageHeight = Math.round(eventImage.height * imageScale);
  }

  const phraseCardHeight = cardPadding * 2 + phraseLines.length * phraseLineHeight;
  const descriptionCardHeight = descriptionLines.length > 0 ? cardPadding * 2 + descriptionLines.length * descriptionLineHeight : 0;
  const imageCardHeight = drawImageHeight > 0 ? imageCardPadding * 2 + drawImageHeight : 0;
  const timeCardHeight = cardPadding + 24 + 12 + timeLines.length * timeLineHeight + cardPadding;

  let panelHeight = panelPadding + phraseCardHeight;
  if (descriptionCardHeight > 0) {
    panelHeight += sectionGap + descriptionCardHeight;
  }
  if (drawImageHeight > 0) {
    panelHeight += sectionGap + imageCardHeight;
  }
  panelHeight += sectionGap + timeCardHeight + panelPadding;

  const height = outerPadding * 2 + panelHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
  bgGradient.addColorStop(0, "#fafcff");
  bgGradient.addColorStop(1, "#f6f8fb");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, width, height);

  const panelX = outerPadding;
  const panelY = outerPadding;
  const panelWidth = width - outerPadding * 2;
  const panelRadius = 26;

  ctx.save();
  ctx.shadowColor = "rgba(22, 34, 52, 0.12)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 12;
  roundedRectPath(ctx, panelX, panelY, panelWidth, panelHeight, panelRadius);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, panelX, panelY, panelWidth, panelHeight, panelRadius);
  ctx.strokeStyle = "#e1e8f0";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const contentX = panelX + panelPadding;
  let y = panelY + panelPadding;

  roundedRectPath(ctx, contentX, y, contentWidth, phraseCardHeight, 20);
  const phraseGradient = ctx.createLinearGradient(contentX, y, contentX + contentWidth, y + phraseCardHeight);
  phraseGradient.addColorStop(0, "#f0fbf8");
  phraseGradient.addColorStop(1, "#ffffff");
  ctx.fillStyle = phraseGradient;
  ctx.fill();
  ctx.strokeStyle = "#bde3dc";
  ctx.lineWidth = 2;
  ctx.stroke();

  y += cardPadding + 42;
  ctx.fillStyle = "#0d5e57";
  ctx.font = '700 48px "Segoe UI", Arial, sans-serif';
  for (const line of phraseLines) {
    ctx.fillText(line, contentX + cardPadding, y);
    y += phraseLineHeight;
  }

  y = panelY + panelPadding + phraseCardHeight;
  if (descriptionCardHeight > 0) {
    y += sectionGap;
    const descriptionCardX = contentX;
    const descriptionCardY = y;
    roundedRectPath(ctx, descriptionCardX, descriptionCardY, contentWidth, descriptionCardHeight, 18);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "#e1e8f0";
    ctx.lineWidth = 2;
    ctx.stroke();

    let descriptionY = descriptionCardY + cardPadding + 30;
    ctx.fillStyle = "#607089";
    ctx.font = '500 30px "Segoe UI", Arial, sans-serif';
    for (const line of descriptionLines) {
      ctx.fillText(line, descriptionCardX + cardPadding, descriptionY);
      descriptionY += descriptionLineHeight;
    }
    y += descriptionCardHeight;
  }

  if (eventImage && drawImageHeight > 0) {
    y += sectionGap;

    const imageCardX = contentX;
    const imageCardY = y;
    roundedRectPath(ctx, imageCardX, imageCardY, contentWidth, imageCardHeight, 18);
    ctx.fillStyle = "#eef3f8";
    ctx.fill();
    ctx.strokeStyle = "#e1e8f0";
    ctx.lineWidth = 2;
    ctx.stroke();

    const imageX = Math.round(imageCardX + (contentWidth - drawImageWidth) / 2);
    const imageY = imageCardY + imageCardPadding;
    ctx.drawImage(eventImage, imageX, imageY, drawImageWidth, drawImageHeight);
    y += imageCardHeight;
  }

  y += sectionGap;

  const timeCardX = contentX;
  const timeCardY = y;
  roundedRectPath(ctx, timeCardX, timeCardY, contentWidth, timeCardHeight, 18);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#e1e8f0";
  ctx.lineWidth = 2;
  ctx.stroke();

  let timeY = timeCardY + cardPadding + 18;
  ctx.fillStyle = "#607089";
  ctx.font = '700 22px "Segoe UI", Arial, sans-serif';
  ctx.fillText("TIME", timeCardX + cardPadding, timeY);
  timeY += 42;

  ctx.fillStyle = "#1c2a3f";
  ctx.font = '700 34px "Segoe UI", Arial, sans-serif';
  for (const line of timeLines) {
    ctx.fillText(line, timeCardX + cardPadding, timeY);
    timeY += timeLineHeight;
  }

  return canvas;
}

async function handleShareSnapshot() {
  if (!el.shareButton) {
    return;
  }

  const priorTitle = el.shareButton.title;
  el.shareButton.disabled = true;
  el.shareButton.title = "Preparing image...";

  try {
    const canvas = await buildShareCanvas();
    if (!canvas) {
      return;
    }

    const timestamp = DateTime.now().toFormat("yyyyLLdd-HHmmss");
    const filename = `fromto-${timestamp}.png`;

    if (isLikelyIPhoneChrome()) {
      const dataUrl = canvas.toDataURL("image/png");
      showSnapshotPreviewOverlay(dataUrl, filename);
      return;
    }

    const blob = await canvasToBlob(canvas);
    const file = new File([blob], filename, { type: "image/png" });

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: "FromTo snapshot",
      });
      return;
    }

    downloadSnapshot(blob, filename);
  } catch (_error) {
    // Keep UI resilient if capture/share is canceled or blocked.
    if (navigator.share) {
      try {
        await navigator.share({
          title: "FromTo",
          text: "FromTo snapshot",
          url: window.location.href,
        });
      } catch (_shareError) {
        // Ignore fallback cancellation/errors.
      }
    }
  } finally {
    el.shareButton.disabled = false;
    el.shareButton.title = priorTitle;
  }
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (lines.length < 2) {
    return [];
  }

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const indexByName = {
    id: headers.indexOf("id"),
    name: headers.indexOf("name"),
    tag: headers.indexOf("tag"),
    description: headers.indexOf("description"),
    date: headers.indexOf("date"),
    time: headers.indexOf("time"),
    timezone: headers.indexOf("timezone"),
  };

  if (indexByName.name < 0 || indexByName.date < 0) {
    return [];
  }

  const events = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const id = indexByName.id >= 0 ? cells[indexByName.id] || "" : "";
    const name = cells[indexByName.name] || "";
    const tag = indexByName.tag >= 0 ? cells[indexByName.tag] || "" : "";
    const description = indexByName.description >= 0 ? cells[indexByName.description] || "" : "";
    const date = cells[indexByName.date] || "";
    const timeRaw = indexByName.time >= 0 ? cells[indexByName.time] || "" : "";
    const timezoneRaw = indexByName.timezone >= 0 ? cells[indexByName.timezone] || "" : "";

    if (!name || !date) {
      continue;
    }

    const time = timeRaw || "00:00";
    const hasExplicitTime = timeRaw.trim().length > 0;
    const baseIso = `${date}T${time}`;
    const timezoneOffset = parseTimezoneOffset(timezoneRaw);
    if (timezoneRaw.length > 0 && timezoneOffset === null) {
      continue;
    }
    const usesFixedTimezone = timezoneOffset !== null;

    const dt = DateTime.fromISO(baseIso, {
      zone: usesFixedTimezone ? FixedOffsetZone.instance(timezoneOffset * 60) : USER_ZONE,
    });

    if (!dt.isValid) {
      continue;
    }

    events.push({
      key: `${id || name}__${date}T${time}__${timezoneRaw || "local"}`,
      id,
      name,
      tag,
      description,
      date,
      time,
      hasExplicitTime,
      timezoneOffset,
      usesFixedTimezone,
      target: dt,
    });
  }

  events.sort((a, b) => a.target.toMillis() - b.target.toMillis());
  return events;
}

function parseTimezoneOffset(raw) {
  if (!raw) {
    return null;
  }

  const normalized = raw.trim();
  if (!/^[+-]?\d{1,2}$/.test(normalized)) {
    return null;
  }

  const offset = Number.parseInt(normalized, 10);
  if (Number.isNaN(offset) || offset < -12 || offset > 12) {
    return null;
  }

  return offset;
}

function getDurationParts(fromDateTime, toDateTime, hasExplicitTime) {
  let from = fromDateTime;
  let to = toDateTime;

  if (!hasExplicitTime) {
    from = from.startOf("day");
    to = to.startOf("day");
  }

  let cursor = from;

  let years = Math.floor(to.diff(cursor, "years").years);
  cursor = cursor.plus({ years });
  while (cursor > to && years > 0) {
    years -= 1;
    cursor = cursor.minus({ years: 1 });
  }

  let days = Math.floor(to.diff(cursor, "days").days);
  cursor = cursor.plus({ days });
  while (cursor > to && days > 0) {
    days -= 1;
    cursor = cursor.minus({ days: 1 });
  }

  if (!hasExplicitTime) {
    return {
      years,
      days,
      hours: 0,
      minutes: 0,
      seconds: 0,
    };
  }

  let hours = Math.floor(to.diff(cursor, "hours").hours);
  cursor = cursor.plus({ hours });
  while (cursor > to && hours > 0) {
    hours -= 1;
    cursor = cursor.minus({ hours: 1 });
  }

  let minutes = Math.floor(to.diff(cursor, "minutes").minutes);
  cursor = cursor.plus({ minutes });
  while (cursor > to && minutes > 0) {
    minutes -= 1;
    cursor = cursor.minus({ minutes: 1 });
  }

  let seconds = Math.floor(to.diff(cursor, "seconds").seconds);
  if (seconds < 0) {
    seconds = 0;
  }

  return {
    years,
    days,
    hours,
    minutes,
    seconds,
  };
}

function formatCompactTimeParts(parts) {
  const unit = (value, singular) => `${value} ${singular}${value === 1 ? "" : "s"}`;
  const units = [];

  if (parts.years > 0) {
    units.push(
      unit(parts.years, "year"),
      unit(parts.days, "day"),
      unit(parts.hours, "hour"),
      unit(parts.minutes, "minute"),
      unit(parts.seconds, "second")
    );
    return units.join(" ");
  }
  if (parts.days > 0) {
    units.push(unit(parts.days, "day"), unit(parts.hours, "hour"), unit(parts.minutes, "minute"), unit(parts.seconds, "second"));
    return units.join(" ");
  }
  if (parts.hours > 0) {
    units.push(unit(parts.hours, "hour"), unit(parts.minutes, "minute"), unit(parts.seconds, "second"));
    return units.join(" ");
  }
  if (parts.minutes > 0) {
    units.push(unit(parts.minutes, "minute"), unit(parts.seconds, "second"));
    return units.join(" ");
  }
  return unit(parts.seconds, "second");
}

function formatDateOnlyTimeParts(parts) {
  const unit = (value, singular) => `${value} ${singular}${value === 1 ? "" : "s"}`;
  if (parts.years > 0) {
    return `${unit(parts.years, "year")} ${unit(parts.days, "day")}`;
  }
  return unit(parts.days, "day");
}

function formatYearsDaysCompact(parts) {
  const yearText = `${parts.years}y`;
  const dayText = `${parts.days}d`;
  if (parts.years > 0) {
    return `${yearText} ${dayText}`;
  }
  return dayText;
}

function lockBodyScroll() {
  state.scrollLockY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add("sidebar-open");
  document.body.style.position = "fixed";
  document.body.style.top = `-${state.scrollLockY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
}

function unlockBodyScroll() {
  document.body.classList.remove("sidebar-open");
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  document.body.style.width = "";
  window.scrollTo(0, state.scrollLockY || 0);
}

function setPhrase(isFuture, eventName, parts, hasExplicitTime) {
  if (!el.metricMain) {
    return;
  }
  const prefix = isFuture ? "There are " : "It has been ";
  const mid = isFuture ? " left until " : " since ";
  const timeText = hasExplicitTime ? formatCompactTimeParts(parts) : formatDateOnlyTimeParts(parts);

  el.metricMain.innerHTML = "";
  el.metricMain.append(document.createTextNode(prefix));

  const emphasis = document.createElement("span");
  emphasis.className = "time-emphasis";
  emphasis.textContent = timeText;
  el.metricMain.append(emphasis);

  const connector = document.createElement("span");
  connector.className = "phrase-connector";
  connector.textContent = mid.trim();
  el.metricMain.append(connector);

  const eventEmphasis = document.createElement("span");
  eventEmphasis.className = "event-emphasis";
  eventEmphasis.textContent = `${eventName}.`;
  el.metricMain.append(eventEmphasis);
}

function buildImageCandidatesById(eventId) {
  if (!eventId) {
    return [];
  }
  const candidates = [];
  for (const ext of IMAGE_EXTENSIONS) {
    candidates.push(`${eventId}.${ext}`);
  }
  return candidates;
}

function encodeRelativePath(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function loadImageManifest() {
  if (state.isImageManifestLoaded) {
    return;
  }

  try {
    const response = await fetch(PIC_MANIFEST_FILE, { cache: "no-store" });
    if (!response.ok) {
      state.isImageManifestLoaded = true;
      return;
    }

    const files = await response.json();
    if (Array.isArray(files)) {
      state.imageManifestSet = new Set(
        files
          .filter((file) => typeof file === "string" && file.trim().length > 0)
          .map((file) => file.trim().toLowerCase())
      );
    }
  } catch (_error) {
    // Keep frontend-only behavior without throwing when manifest is missing.
  } finally {
    state.isImageManifestLoaded = true;
  }
}

async function resolveEventImage(eventId) {
  const cacheKey = eventId || "";
  if (state.imageCache.has(cacheKey)) {
    return state.imageCache.get(cacheKey);
  }

  if (state.imageResolvePromises.has(cacheKey)) {
    return state.imageResolvePromises.get(cacheKey);
  }

  const candidates = buildImageCandidatesById(eventId);
  const resolving = (async () => {
    if (!state.isImageManifestLoaded) {
      await loadImageManifest();
    }

    if (state.imageManifestSet.size === 0 || candidates.length === 0) {
      state.imageCache.set(cacheKey, null);
      return null;
    }

    for (const candidate of candidates) {
      if (state.imageManifestSet.has(candidate.toLowerCase())) {
        const src = `${PIC_DIR}/${encodeRelativePath(candidate)}`;
        state.imageCache.set(cacheKey, src);
        return src;
      }
    }

    state.imageCache.set(cacheKey, null);
    return null;
  })();

  state.imageResolvePromises.set(cacheKey, resolving);
  const matched = await resolving;
  state.imageResolvePromises.delete(cacheKey);
  return matched;
}

async function renderEventImage(event) {
  if (state.lastImageEventKey === event.key) {
    return;
  }
  state.lastImageEventKey = event.key;

  const matchedImage = await resolveEventImage(event.id);
  const activeEvent = state.events[state.activeIndex];
  if (!activeEvent || activeEvent.key !== event.key) {
    return;
  }

  if (matchedImage) {
    el.image.src = matchedImage;
    el.image.alt = `${event.name} picture`;
    el.imageWrap.classList.remove("hidden");
    return;
  }

  el.image.src = "";
  el.image.alt = "";
  el.imageWrap.classList.add("hidden");
}

function setActiveEvent(index, updateUrl = true) {
  if (index < 0 || index >= state.events.length) return;
  
  state.activeIndex = index;
  renderEventList();
  renderDetail(true);
  closeSidebar();
  
  if (updateUrl && !state.isInitialLoad) {
    const event = state.events[index];
    navigateToEvent(event.id);
  }
  
  // Update page title
  const event = state.events[index];
  document.title = `${event.name} - FromTo`;
}

function getFilteredEvents() {
  const mapped = state.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => state.activeTag === "All" || (event.tag || "Untagged") === state.activeTag);

  mapped.sort((a, b) => b.event.target.toMillis() - a.event.target.toMillis());
  return mapped;
}

function renderTagFilter() {
  if (!el.tagFilterButtons) {
    return;
  }
  const tags = Array.from(
    new Set(state.events.map((event) => (event.tag && event.tag.trim() ? event.tag.trim() : "Untagged")))
  ).sort((a, b) => a.localeCompare(b));

  const allTags = ["All", ...tags];
  if (!allTags.includes(state.activeTag)) {
    state.activeTag = "All";
  }

  el.tagFilterButtons.innerHTML = "";
  allTags.forEach((tag) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tag-chip${tag === state.activeTag ? " active" : ""}`;
    button.textContent = tag;
    button.addEventListener("click", () => {
      applyTagFilter(tag);
    });
    el.tagFilterButtons.appendChild(button);
  });
}

function applyTagFilter(tag) {
  state.activeTag = tag;
  renderTagFilter();

  const filtered = getFilteredEvents();
  if (filtered.length > 0) {
    const hasActive = filtered.some(({ index }) => index === state.activeIndex);
    if (!hasActive) {
      state.activeIndex = filtered[0].index;
      renderDetail(true);
    }
  }

  renderEventList();
}

function renderEventList() {
  if (!el.list) {
    return;
  }
  el.list.innerHTML = "";
  const now = DateTime.now().setZone(USER_ZONE);
  const filtered = getFilteredEvents();

  if (filtered.length === 0) {
    const noResult = document.createElement("p");
    noResult.className = "event-list-empty";
    noResult.textContent = "No events for this tag.";
    el.list.appendChild(noResult);
    return;
  }

  filtered.forEach(({ event, index }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `event-item${index === state.activeIndex ? " active" : ""}`;
    button.addEventListener("click", () => navigateToEvent(event.id));

    const isFuture = event.target.toMillis() >= now.toMillis();
    const status = isFuture ? "Upcoming" : "Memory";
    const yearsDaysParts = isFuture
      ? getDurationParts(now, event.target, true)
      : getDurationParts(event.target, now, true);
    const simplifiedDuration = formatYearsDaysCompact(yearsDaysParts);
    button.innerHTML =
      `<span class="event-item-name">${event.name}</span>` +
      `<span class="event-item-sub">${status}</span>` +
      `<span class="event-item-foot">` +
      `<span class="event-item-tag">${event.tag || "Untagged"}</span>` +
      `<span class="event-item-reltime ${isFuture ? "event-item-reltime-future" : "event-item-reltime-past"}">${simplifiedDuration}</span>` +
      `</span>`;

    el.list.appendChild(button);
  });
}

function openSidebar() {
  if (!el.sidebar || !el.overlay) {
    return;
  }
  state.isSidebarOpen = true;
  lockBodyScroll();
  el.sidebar.classList.add("open");
  el.overlay.classList.remove("hidden");
  el.sidebar.setAttribute("aria-hidden", "false");
}

function closeSidebar() {
  if (!el.sidebar || !el.overlay) {
    return;
  }
  state.isSidebarOpen = false;
  unlockBodyScroll();
  el.sidebar.classList.remove("open");
  el.overlay.classList.add("hidden");
  el.sidebar.setAttribute("aria-hidden", "true");
}

function renderDetail(includeImage = false) {
  const event = state.events[state.activeIndex];
  if (!event || !el.description || !el.localTime) {
    return;
  }

  const now = DateTime.now().setZone(USER_ZONE);
  const targetInUserZone = event.target.setZone(USER_ZONE);
  const diff = targetInUserZone.toMillis() - now.toMillis();
  const isFuture = diff >= 0;

  el.description.textContent = event.description || "No description provided.";
  el.localTime.textContent = event.hasExplicitTime
    ? targetInUserZone.toLocaleString(DateTime.DATETIME_FULL_WITH_SECONDS)
    : targetInUserZone.toLocaleString(DateTime.DATE_FULL);

  if (isFuture) {
    const parts = getDurationParts(now, targetInUserZone, event.hasExplicitTime);
    setPhrase(true, event.name, parts, event.hasExplicitTime);
  } else {
    const parts = getDurationParts(targetInUserZone, now, event.hasExplicitTime);
    setPhrase(false, event.name, parts, event.hasExplicitTime);
  }

  if (includeImage) {
    renderEventImage(event);
  }
}

async function loadEvents() {
  try {
    if (!el.loading || !el.empty || !el.detail) {
      return;
    }
    const response = await fetch(EVENT_FILE, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unable to load ${EVENT_FILE}: ${response.status}`);
    }

    const csvText = await response.text();
    state.events = parseCsv(csvText);

    el.loading.classList.add("hidden");

    if (state.events.length === 0) {
      el.empty.classList.remove("hidden");
      return;
    }

    // Check URL for initial event ID
    const urlEventId = parseUrlPath();
    if (urlEventId) {
      state.activeIndex = getEventIndexById(urlEventId);
    } else if (state.events.length > 0) {
      // If no event ID in URL, redirect to first event
      const firstEvent = state.events[0];
      window.history.replaceState({ eventId: firstEvent.id }, '', `/event/${firstEvent.id}`);
    }

    el.detail.classList.remove("hidden");
    renderTagFilter();
    renderEventList();
    renderDetail(true);

    // Update page title for initial event
    const currentEvent = state.events[state.activeIndex];
    document.title = `${currentEvent.name} - FromTo`;

    if (state.timerId) {
      clearInterval(state.timerId);
    }
    state.timerId = setInterval(() => renderDetail(false), 1000);
    
    state.isInitialLoad = false;
  } catch (error) {
    el.loading.textContent = `Failed to load events. ${String(error.message || error)}`;
  }
}

if (el.sidebarToggle) {
  el.sidebarToggle.addEventListener("click", () => {
    if (state.isSidebarOpen) {
      closeSidebar();
      return;
    }
    openSidebar();
  });
}

if (el.shareButton) {
  el.shareButton.addEventListener("click", handleShareSnapshot);
}

if (el.sidebarClose) {
  el.sidebarClose.addEventListener("click", closeSidebar);
}
if (el.overlay) {
  el.overlay.addEventListener("click", closeSidebar);
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.isSidebarOpen) {
    closeSidebar();
  }
});

window.addEventListener("popstate", (event) => {
  const eventId = event.state?.eventId || parseUrlPath();
  const index = getEventIndexById(eventId);
  setActiveEvent(index, false); // Don't update URL since we're responding to URL change
});

loadEvents();
