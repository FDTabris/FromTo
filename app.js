const { DateTime, FixedOffsetZone } = luxon;

const EVENT_FILE = "events.csv";
const PIC_DIR = "pic";
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
};

const el = {
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

function setPhrase(isFuture, eventName, parts, hasExplicitTime) {
  if (!el.metricMain) {
    return;
  }
  const prefix = isFuture ? "There are " : "There have been ";
  const mid = isFuture ? " until " : " since ";
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

function setActiveEvent(index) {
  state.activeIndex = index;
  renderEventList();
  renderDetail(true);
  closeSidebar();
}

function getFilteredEvents() {
  if (state.activeTag === "All") {
    return state.events.map((event, index) => ({ event, index }));
  }
  return state.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => (event.tag || "Untagged") === state.activeTag);
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
    button.addEventListener("click", () => setActiveEvent(index));

    const isFuture = event.target.toMillis() >= now.toMillis();
    const status = isFuture ? "Upcoming" : "Memory";
    const eventTimeInUserZone = event.target.setZone(USER_ZONE).toFormat("yyyy-LL-dd HH:mm");
    button.innerHTML =
      `<span class="event-item-name">${event.name}</span>` +
      `<span class="event-item-sub">${status} · ${eventTimeInUserZone}</span>` +
      `<span class="event-item-tag">${event.tag || "Untagged"}</span>`;

    el.list.appendChild(button);
  });
}

function openSidebar() {
  if (!el.sidebar || !el.overlay) {
    return;
  }
  state.isSidebarOpen = true;
  el.sidebar.classList.add("open");
  el.overlay.classList.remove("hidden");
  el.sidebar.setAttribute("aria-hidden", "false");
}

function closeSidebar() {
  if (!el.sidebar || !el.overlay) {
    return;
  }
  state.isSidebarOpen = false;
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

    el.detail.classList.remove("hidden");
    renderTagFilter();
    renderEventList();
    renderDetail(true);

    if (state.timerId) {
      clearInterval(state.timerId);
    }
    state.timerId = setInterval(() => renderDetail(false), 1000);
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

loadEvents();
