// =======================================
// Fitness First Widget
// =======================================

const CLUBS = await fetchJSON("https://raw.githubusercontent.com/jesperschlegel/FitnessFirstWidget/refs/heads/main/assets/clubs.json");
const CLUB_ID = args.widgetParameter || "1337440790";

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

// ---------- Bar Chart ----------
function drawBarChart(items, opening, closing) {
    const ctx = new DrawContext();
    ctx.size = new Size(WIDTH, HEIGHT + 16);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    const barWidth = (WIDTH - GAP * items.length) / items.length;

    // Draw bars
    items.forEach((item, i) => {
        const h = Math.min(Math.max(item.percentage, 0), 100) / 100 * HEIGHT;
        const x = i * (barWidth + GAP);
        const y = HEIGHT - h;
        ctx.setFillColor(barColor(item));
        ctx.fillRect(new Rect(x, y, barWidth, h));
    });

    // Draw opening/closing labels
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
        console.error(e);
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

    const clubText = headerLeft.addText(CLUBS.find(c => c.usage_id === CLUB_ID)?.name || "Unbekanntes Studio");
    clubText.font = Font.boldSystemFont(14);
    clubText.textColor = Color.white();

    const now = new Date();
    const pad = (n) => n.toString().padStart(2, "0");
    const formattedTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const openingHoursText = headerLeft.addText(`Öffnungszeiten: ${formatTime(open)} - ${formatTime(close)}`);
    openingHoursText.font = Font.mediumSystemFont(12);
    openingHoursText.textColor = COLORS.grayText;

    const updated = headerLeft.addText(`Stand: ${formattedTime}`);
    updated.font = Font.mediumSystemFont(12);
    updated.textColor = COLORS.grayText;

    // Header Right (Image)
    header.addSpacer();
    const headerRight = header.addStack();
    headerRight.layoutVertically();
    headerRight.centerAlignContent();

    let image = await new Request("https://raw.githubusercontent.com/jesperschlegel/FitnessFirstWidget/refs/heads/main/assets/logo.png").loadImage();
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

        const level = left.addText(current.level.toUpperCase());
        level.font = Font.systemFont(12);
        level.textColor = levelColor(current.level);
    } else {
        left.addText("--");
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

// ---------- Run ----------
const widget = await createWidget();

if (config.runsInWidget) {
    Script.setWidget(widget);
} else {
    widget.presentMedium();
}

Script.complete();
