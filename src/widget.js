// =======================================
// Fitness First Widget
// =======================================

const VERSION = "1.0.1";

const fm = FileManager.local();
const CACHE_DIR = fm.joinPath(fm.documentsDirectory(), "fitnessfirst-widget-cache");
if (!fm.fileExists(CACHE_DIR)) fm.createDirectory(CACHE_DIR);

const CLUBS = await fetchWithCache({
    url: "https://raw.githubusercontent.com/jesperschlegel/FitnessFirstWidget/refs/heads/main/assets/clubs.json",
    key: "clubs",
    type: "json"
});
const CLUB_ID = args.widgetParameter || "1337440790";
const SELECTED_CLUB = CLUBS.find(c => c.usage_id === CLUB_ID);

const URL_CURRENT = `https://www.fitnessfirst.de/club/api/checkins/${CLUB_ID}`;
const URL_FORECAST = `https://www.fitnessfirst.de/club/api/usage/week/${CLUB_ID}`;

// ---------- Constants ----------
const WIDTH = 220;
const HEIGHT = 80;
const GAP = 4;
const COLORS = {
    current: new Color("#be2c2b"),
    future: Color.lightGray(),
    past: Color.darkGray(),
    grayText: Color.gray(),
    low: Color.gray(),
    normal: Color.yellow(),
    high: new Color("#be2c2b"),
};

// ---------- Fetch ----------
async function fetchJSON(url) {
    const req = new Request(url);
    req.headers = { "Accept": "application/json" };
    return await req.loadJSON();
}

// ---------- Helpers ----------
const barColor = (item) =>
    item.isCurrent ? COLORS.current : item.isFuture ? COLORS.future : COLORS.past;

const levelLabel = (level) => {
    switch (level.toLowerCase()) {
        case "low":
            return "Niedrig";
        case "normal":
            return "Normal";
        case "high":
            return "Hoch";
        default:
            return "Unbekannt";
    }
};

const levelColor = (level) => {
    switch (level.toLowerCase()) {
        case "low":
            return COLORS.low;
        case "normal":
            return COLORS.normal;
        case "high":
            return COLORS.high;
        default:
            return Color.grayText();
    }
};

const formatTime = (t) => t?.split(":").slice(0, 2).join(":") ?? "--:--";

// ---------- Cache Helpers ----------
function cachePaths(key) {
    return {
        data: fm.joinPath(CACHE_DIR, `${key}.data`),
        meta: fm.joinPath(CACHE_DIR, `${key}.meta.json`)
    };
}

async function fetchWithCache({ url, key, type = "json" }) {
    const { data, meta } = cachePaths(key);

    let headers = {};
    if (fm.fileExists(meta)) {
        const metaData = JSON.parse(fm.readString(meta));
        if (metaData.etag) headers["If-None-Match"] = metaData.etag;
        if (metaData.lastModified) headers["If-Modified-Since"] = metaData.lastModified;
    }

    try {
        const req = new Request(url);
        req.headers = headers;
        req.method = "GET";

        if (type === "json") {
            const res = await req.load();
            if (req.response.statusCode === 304 && fm.fileExists(data)) {
                return JSON.parse(fm.readString(data));
            }

            fm.writeString(data, res.toRawString());
            fm.writeString(meta, JSON.stringify({
                etag: req.response.headers["ETag"],
                lastModified: req.response.headers["Last-Modified"],
                cachedAt: Date.now()
            }));
            return JSON.parse(res.toRawString());
        }

        if (type === "image") {
            const img = await req.loadImage();
            fm.writeImage(data, img);
            fm.writeString(meta, JSON.stringify({
                etag: req.response.headers["ETag"],
                lastModified: req.response.headers["Last-Modified"],
                cachedAt: Date.now()
            }));
            return img;
        }
    } catch (err) {
        if (fm.fileExists(data)) {
            if (type === "json") return JSON.parse(fm.readString(data));
            if (type === "image") return fm.readImage(data);
        }
        throw err;
    }
}

// ---------- Bar Chart ----------
function drawBarChart(items, opening, closing) {
    const ctx = new DrawContext();
    ctx.size = new Size(WIDTH, HEIGHT + 16);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    const barWidth = (WIDTH - GAP * items.length) / items.length;

    items.forEach((item, i) => {
        const h = Math.min(Math.max(item.percentage, 0), 100) / 100 * HEIGHT;
        const x = i * (barWidth + GAP);
        const y = HEIGHT - h;
        ctx.setFillColor(barColor(item));
        ctx.fillRect(new Rect(x, y, barWidth, h));
    });

    ctx.setFont(Font.systemFont(8));
    ctx.setTextColor(COLORS.grayText);

    ctx.setTextAlignedLeft();
    ctx.drawText(formatTime(opening), new Point(2, HEIGHT + 2));

    ctx.setTextAlignedRight();
    ctx.drawText(formatTime(closing), new Point(WIDTH - 25, HEIGHT + 2));

    return ctx.getImage();
}

// ---------- Widget ----------
async function createWidget() {
    const widget = new ListWidget();
    widget.setPadding(12, 12, 12, 12);

    // ---------- Fetch data ----------
    let currentData, forecastData;
    try {
        [currentData, forecastData] = await Promise.all([
            fetchJSON(URL_CURRENT),
            fetchJSON(URL_FORECAST),
        ]);
    } catch (e) {
        widget.addText("⚠️ Load error");
        return widget;
    }

    const currentItems = currentData?.data?.items ?? [];
    const current = currentItems.find((i) => i.isCurrent);

    const today = Object.values(forecastData?.data ?? {}).find((item) => item.isToday);
    const { startTime: open, endTime: close, items: forecastItems = [] } = today?.data ?? {};

    // ---------- Header ----------
    const header = widget.addStack();
    header.layoutHorizontally();
    header.centerAlignContent();

    // Header Left
    const headerLeft = header.addStack();
    headerLeft.layoutVertically();
    headerLeft.spacing = 2;
    headerLeft.addSpacer(10);

    const clubText = headerLeft.addText(SELECTED_CLUB?.name || "Unbekanntes Studio");
    clubText.font = Font.boldSystemFont(14);
    clubText.textColor = Color.white();

    const now = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const formattedTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const openingHoursText = headerLeft.addText(`Öffnungszeiten: ${formatTime(open)} - ${formatTime(close)}`);
    openingHoursText.font = Font.mediumSystemFont(12);
    openingHoursText.textColor = COLORS.grayText;

    const updated = headerLeft.addText(`Aktualisiert: ${formattedTime}`);
    updated.font = Font.mediumSystemFont(12);
    updated.textColor = COLORS.grayText;

    // Header Right (Image)
    header.addSpacer();
    const headerRight = header.addStack();
    headerRight.layoutVertically();
    headerRight.centerAlignContent();

    let image = await fetchWithCache({
        url: "https://raw.githubusercontent.com/jesperschlegel/FitnessFirstWidget/refs/heads/main/assets/logo.png",
        key: "logo",
        type: "image"
    });

    const imgElement = headerRight.addImage(image);
    imgElement.imageSize = new Size(45, 45);
    imgElement.cornerRadius = 8;

    widget.addSpacer(8);

    // ---------- Body ----------
    const body = widget.addStack();
    body.layoutHorizontally();
    body.spacing = 12;

    // LEFT: CURRENT
    const left = body.addStack();
    left.layoutVertically();
    left.centerAlignContent();

    left.addSpacer(4);

    if (current) {
        const percent = left.addText(`${current.percentage}%`);
        percent.font = Font.boldSystemFont(36);
        percent.textColor = Color.white();

        const level = left.addText(levelLabel(current.level));
        level.font = Font.systemFont(12);
        level.textColor = levelColor(current.level);
    } else {
        left.addText("--");
        const closedText = left.addText("Aktuell geschlossen");
        closedText.font = Font.mediumSystemFont(12);
        closedText.textColor = COLORS.grayText;
    }

    // RIGHT: FORECAST
    const right = body.addStack();
    right.layoutVertically();
    right.centerAlignContent();

    right.addSpacer(2);

    if (forecastItems.length > 0) {
        const chartImage = drawBarChart(forecastItems, open, close);
        const chart = right.addImage(chartImage);
        chart.imageSize = new Size(WIDTH, HEIGHT);
    }

    // ---------- Background ----------
    const gradient = new LinearGradient();
    gradient.colors = [new Color("#1c1c1e"), new Color("#2c2c2e")];
    gradient.locations = [0, 1];
    widget.backgroundGradient = gradient;

    return widget;
}

// ---------- Umami ----------

const SESSION_FILE = "umami_session_id.txt";

function getSessionId() {
    const path = fm.joinPath(fm.documentsDirectory(), SESSION_FILE);
    if (fm.fileExists(path)) {
        return fm.readString(path);
    }
    return null;
}

function saveSessionId(sessionId) {
    const path = fm.joinPath(fm.documentsDirectory(), SESSION_FILE);
    fm.writeString(path, sessionId);
}

function getUmamiPayload(sessionId) {
    const screen = Device.screenSize();

    const payload = {
        hostname: "ffw.com",
        language: Device.locale(),
        referrer: "",
        screen: `${screen.width}x${screen.height}`,
        title: "widget",
        url: "/",
        website: "d4cf6619-60e3-405a-a366-02084a109ad9",
        name: "widget_run",
        data: {
            widget_version: VERSION,
            device: {
                name: Device.name(),
                isUsingDarkApppearance: Device.isUsingDarkAppearance(),
                locale: Device.locale(),
                language: Device.language(),
                screen: `${screen.width}x${screen.height}`,
                operating_system: Device.systemName(),
                operating_system_version: Device.systemVersion(),
                model: Device.model(),
                brand: "Apple",
            },
            user: {
                club: SELECTED_CLUB
            }
        }
    }
    
    if (sessionId) payload.id = sessionId;
    
    return payload;
}

async function sendUmamiEvent() {
    const existingSessionId = getSessionId();
    const payload = getUmamiPayload(existingSessionId);
    const req = new Request("https://cloud.umami.is/api/send");
    req.method = "POST";
    req.headers = {
        "Content-Type": "application/json",
        "User-Agent": `FitnessFirstWidget/${VERSION} (${Device.systemName()} ${Device.systemVersion()})`
    };
    req.body = JSON.stringify(
        {
            type: "event",
            payload: payload
        }
    );

    try {
        const response = await req.loadJSON();
        const returnedSessionId = response?.sessionId;
        if (!existingSessionId && returnedSessionId) {
            saveSessionId(returnedSessionId);
        }
    } catch (e) {
        // Ignore errors
    }
}

// ---------- Run ----------
const widget = await createWidget();
await sendUmamiEvent();

if (config.runsInWidget) {
    Script.setWidget(widget);
} else {
    widget.presentMedium();
}

Script.complete();
