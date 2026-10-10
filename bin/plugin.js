const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_TARGET_MS = Date.UTC(new Date().getUTCFullYear() + 1, 0, 1);
const COUNTDOWN_FILE = path.join(__dirname, "countdowns.json");

const DEFAULT_COLORS = {
  backgroundColor: "#111827",
  numberColor: "#FFFFFF",
  labelColor: "#D8D8DC"
};

const DEFAULT_FONT = {
  labelSize: 18,
  numberSize: 40
};

let pluginId = null;

const PARTS = {
  "com.lvercauteren.datecountdown.days": { label: "DAYS", kind: "days" },
  "com.lvercauteren.datecountdown.hours": { label: "HOURS", kind: "hours" },
  "com.lvercauteren.datecountdown.minutes": { label: "MINUTES", kind: "minutes" },
  "com.lvercauteren.datecountdown.seconds": { label: "SECONDS", kind: "seconds" },
  "com.lvercauteren.datecountdown.custom": { label: "COUNTDOWN", kind: "custom" }
};

const UNIT_ORDER = ["days", "hours", "minutes", "seconds"];
const UNIT_SECONDS = { days: 86400, hours: 3600, minutes: 60, seconds: 1 };
const UNIT_LABELS = { days: "DAYS", hours: "HOURS", minutes: "MINUTES", seconds: "SECONDS" };
const UNIT_SHORT_LABELS = { days: "DAYS", hours: "HRS", minutes: "MIN", seconds: "SEC" };
const MAX_REACHED_TEXT = 20;

// Legacy actions always show their single unit; the custom action defaults to all four.
function defaultUnits(uuid) {
  const part = PARTS[uuid];
  return part && part.kind !== "custom" ? [part.kind] : UNIT_ORDER.slice();
}

function normalizeUnits(units, uuid) {
  const part = PARTS[uuid];
  if (part && part.kind !== "custom") return [part.kind];
  if (!Array.isArray(units)) return defaultUnits(uuid);
  const valid = UNIT_ORDER.filter(u => units.includes(u));
  return valid.length > 0 ? valid : defaultUnits(uuid);
}

function normalizeReachedText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_REACHED_TEXT).trim();
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Rough font size so `text` fits `maxWidth`; textLength is only needed below the minimum size.
function fitText(text, baseSize, maxWidth, minSize = 10) {
  const estimate = size => text.length * size * 0.62;
  let size = baseSize;
  if (estimate(size) > maxWidth) size = Math.max(minSize, Math.floor(maxWidth / (text.length * 0.62)));
  return { size, squeeze: estimate(size) > maxWidth };
}

// ---------------------------------------------------------------------------
// Countdown slots (global list, each button/dial picks one by index)
// ---------------------------------------------------------------------------

// "local" means the machine's own time zone; otherwise an IANA name.
function normalizeTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone || timeZone === "local") {
    return "local";
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return "local";
  }
}

function defaultSlots() {
  return [
    { name: "Countdown", targetDate: new Date(DEFAULT_TARGET_MS).toISOString(), timeZone: "local" }
  ];
}

let COUNTDOWN_SLOTS = [];

function loadCountdownSlots() {
  try {
    const data = JSON.parse(fs.readFileSync(COUNTDOWN_FILE, "utf8"));
    if (Array.isArray(data.slots)) {
      const valid = data.slots
        .filter(slot =>
          slot &&
          typeof slot === "object" &&
          Number.isFinite(Date.parse(slot.targetDate || ""))
        )
        .map((slot, i) => ({
          name: String(slot.name || "").trim() || `Slot ${i + 1}`,
          targetDate: new Date(Date.parse(slot.targetDate)).toISOString(),
          timeZone: normalizeTimeZone(slot.timeZone)
        }));
      if (valid.length > 0) {
        COUNTDOWN_SLOTS = valid;
        return;
      }
    }
  } catch { }

  COUNTDOWN_SLOTS = defaultSlots();
}

function saveCountdownSlots() {
  fs.writeFileSync(
    COUNTDOWN_FILE,
    JSON.stringify({ slots: COUNTDOWN_SLOTS }, null, 2),
    "utf8"
  );
}

loadCountdownSlots();

function clampSlotIndex(index) {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= COUNTDOWN_SLOTS.length) return 0;
  return n;
}

function getSlotTargetMs(index) {
  const slot = COUNTDOWN_SLOTS[clampSlotIndex(index)];
  const ms = slot ? Date.parse(slot.targetDate) : NaN;
  return Number.isFinite(ms) ? ms : DEFAULT_TARGET_MS;
}

class SimpleWebSocket {
  constructor(url, onOpen, onMessage, onClose) {
    const m = /^ws:\/\/([^/:]+):(\d+)(\/.*)?$/.exec(url);
    if (!m) throw new Error("Only ws://host:port URLs are supported");
    this.host = m[1];
    this.port = Number(m[2]);
    this.path = m[3] || "/";
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshaken = false;
    this.closed = false;
  }

  connect() {
    this.socket = net.createConnection({ host: this.host, port: this.port });
    const key = crypto.randomBytes(16).toString("base64");

    this.socket.on("connect", () => {
      this.socket.write(
        `GET ${this.path} HTTP/1.1\r\n` +
        `Host: ${this.host}:${this.port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    this.socket.on("data", chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (!this.handshaken) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = this.buffer.subarray(0, end).toString("utf8");
        if (!/^HTTP\/1\.[01] 101 /.test(header)) {
          this.close();
          return;
        }
        this.handshaken = true;
        this.buffer = this.buffer.subarray(end + 4);
        this.onOpen();
      }
      this.parseFrames();
    });

    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let pos = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); pos = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0) throw new Error("Frame too large");
        len = low; pos = 10;
      }

      const masked = (b1 & 0x80) !== 0;
      let mask;
      if (masked) {
        if (this.buffer.length < pos + 4) return;
        mask = this.buffer.subarray(pos, pos + 4); pos += 4;
      }
      if (this.buffer.length < pos + len) return;

      let payload = Buffer.from(this.buffer.subarray(pos, pos + len));
      this.buffer = this.buffer.subarray(pos + len);

      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode === 0x1 && fin) {
        this.onMessage(payload.toString("utf8"));
      }
    }
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    payload = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(payload.length, 6);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  sendText(text) { this.sendFrame(0x1, Buffer.from(text, "utf8")); }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.socket && !this.socket.destroyed) this.socket.end();
    } catch { }
    if (this.onClose) this.onClose();
  }
}

let ws = null;
let contexts = new Map();
let timer = null;

function send(obj) {
  if (ws) ws.sendText(JSON.stringify(obj));
}

function startConnection() {
  const args = process.argv.slice(2);
  const port = args[args.indexOf("-port") + 1];
  pluginId = args[args.indexOf("-pluginUUID") + 1];
  const registerEvent = args[args.indexOf("-registerEvent") + 1];

  if (!port || !pluginId || !registerEvent) {
    process.stderr.write("Date Countdown: missing Stream Deck startup arguments\n");
    process.exit(2);
  }

  ws = new SimpleWebSocket(
    `ws://127.0.0.1:${port}`,
    () => {
      send({ event: registerEvent, uuid: pluginId });
    },
    handleMessage,
    () => {
      ws = null;
      if (timer) { clearInterval(timer); timer = null; }
      setTimeout(startConnection, 1000);
    }
  );
  ws.connect();
}

function sendSlotsToInspector(context) {
  const entry = contexts.get(context);
  send({
    event: "sendToPropertyInspector",
    context,
    payload: {
      slots: COUNTDOWN_SLOTS,
      selectedIndex: entry ? clampSlotIndex(entry.slotIndex) : 0
    }
  });
}

function persistSettings(context, settings) {
  send({
    event: "setSettings",
    context,
    payload: settings
  });
}

function persistEntry(context) {
  const entry = contexts.get(context);
  if (!entry) return;
  persistSettings(context, {
    slotIndex: entry.slotIndex,
    backgroundColor: entry.backgroundColor,
    numberColor: entry.numberColor,
    labelColor: entry.labelColor,
    labelSize: entry.labelSize,
    numberSize: entry.numberSize,
    units: entry.units,
    reachedText: entry.reachedText
  });
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.event === "sendToPlugin") {
    const payload = msg.payload || {};

    if (payload.command === "getColorSettings") {
      const entry = contexts.get(msg.context);
      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: {
          colors: entry
            ? {
              backgroundColor: entry.backgroundColor || DEFAULT_COLORS.backgroundColor,
              numberColor: entry.numberColor || DEFAULT_COLORS.numberColor,
              labelColor: entry.labelColor || DEFAULT_COLORS.labelColor
            }
            : DEFAULT_COLORS
        }
      });

    } else if (payload.command === "saveColorSettings") {
      const colors = payload.colors || {};
      const validColor = value =>
        typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);

      if (
        validColor(colors.backgroundColor) &&
        validColor(colors.numberColor) &&
        validColor(colors.labelColor)
      ) {
        const entry = contexts.get(msg.context);
        if (entry) {
          entry.backgroundColor = colors.backgroundColor;
          entry.numberColor = colors.numberColor;
          entry.labelColor = colors.labelColor;

          // Persist to Stream Deck settings
          persistEntry(msg.context);

          updateContext(msg.context);

          send({
            event: "sendToPropertyInspector",
            context: msg.context,
            payload: { colorsSaved: true }
          });
        }
      } else {
        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { colorsError: "Please choose valid colors." }
        });
      }

    } else if (payload.command === "getFontSettings") {
      const entry = contexts.get(msg.context);
      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: {
          labelSize: entry ? (entry.labelSize || DEFAULT_FONT.labelSize) : DEFAULT_FONT.labelSize,
          numberSize: entry ? (entry.numberSize || DEFAULT_FONT.numberSize) : DEFAULT_FONT.numberSize
        }
      });

    } else if (payload.command === "saveFontSettings") {
      const labelSize = Number(payload.labelSize);
      const numberSize = Number(payload.numberSize);

      if (
        Number.isFinite(labelSize) &&
        labelSize >= 12 && labelSize <= 60 &&
        Number.isFinite(numberSize) &&
        numberSize >= 12 && numberSize <= 60
      ) {
        const entry = contexts.get(msg.context);
        if (entry) {
          entry.labelSize = labelSize;
          entry.numberSize = numberSize;

          // Persist to Stream Deck settings
          persistEntry(msg.context);

          updateContext(msg.context);

          send({
            event: "sendToPropertyInspector",
            context: msg.context,
            payload: {
              labelSize,
              numberSize,
              fontSaved: true
            }
          });
        }
      }

    } else if (payload.command === "getDisplaySettings") {
      const entry = contexts.get(msg.context);
      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: {
          units: entry ? normalizeUnits(entry.units, entry.uuid) : UNIT_ORDER.slice(),
          reachedText: entry ? normalizeReachedText(entry.reachedText) : ""
        }
      });

    } else if (payload.command === "saveDisplaySettings") {
      const entry = contexts.get(msg.context);
      if (entry) {
        const unitsGiven = payload.units !== undefined;
        const unitsOk =
          !unitsGiven ||
          (Array.isArray(payload.units) &&
            payload.units.length > 0 &&
            payload.units.every(u => UNIT_ORDER.includes(u)));
        const textOk =
          payload.reachedText === undefined ||
          (typeof payload.reachedText === "string" &&
            payload.reachedText.trim().length <= MAX_REACHED_TEXT);

        if (unitsOk && textOk) {
          if (unitsGiven) entry.units = normalizeUnits(payload.units, entry.uuid);
          if (payload.reachedText !== undefined) {
            entry.reachedText = normalizeReachedText(payload.reachedText);
          }
          persistEntry(msg.context);
          updateContext(msg.context);
          send({
            event: "sendToPropertyInspector",
            context: msg.context,
            payload: {
              displaySaved: true,
              units: entry.units,
              reachedText: entry.reachedText
            }
          });
        } else {
          send({
            event: "sendToPropertyInspector",
            context: msg.context,
            payload: {
              displayError: !unitsOk
                ? "Select at least one unit to display."
                : `Text must be at most ${MAX_REACHED_TEXT} characters.`,
              units: normalizeUnits(entry.units, entry.uuid),
              reachedText: normalizeReachedText(entry.reachedText)
            }
          });
        }
      }

    } else if (payload.command === "getCountdownSlots") {
      sendSlotsToInspector(msg.context);

    } else if (payload.command === "selectCountdownSlot") {
      const index = Number(payload.index);
      const entry = contexts.get(msg.context);

      if (entry && Number.isInteger(index) && index >= 0 && index < COUNTDOWN_SLOTS.length) {
        entry.slotIndex = index;
        persistEntry(msg.context);
        updateContext(msg.context);
      }

      sendSlotsToInspector(msg.context);

    } else if (payload.command === "addCountdownSlot") {
      const ms = Date.parse(payload.targetDate || "");

      if (!Number.isFinite(ms)) {
        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { slotError: "Choose a valid date." }
        });
      } else {
        const name = String(payload.name || "").trim() || `Slot ${COUNTDOWN_SLOTS.length + 1}`;
        COUNTDOWN_SLOTS.push({
          name,
          targetDate: new Date(ms).toISOString(),
          timeZone: normalizeTimeZone(payload.timeZone)
        });
        saveCountdownSlots();

        // Make this button use the newly created slot.
        const entry = contexts.get(msg.context);
        if (entry) {
          entry.slotIndex = COUNTDOWN_SLOTS.length - 1;
          persistEntry(msg.context);
        }

        updateAll();
        sendSlotsToInspector(msg.context);
      }

    } else if (payload.command === "saveCountdownSlot") {
      const index = Number(payload.index);
      const ms = Date.parse(payload.targetDate || "");

      if (!Number.isInteger(index) || index < 0 || index >= COUNTDOWN_SLOTS.length || !Number.isFinite(ms)) {
        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { slotError: "Could not save that slot." }
        });
      } else {
        COUNTDOWN_SLOTS[index] = {
          name: String(payload.name || "").trim() || `Slot ${index + 1}`,
          targetDate: new Date(ms).toISOString(),
          timeZone: normalizeTimeZone(payload.timeZone)
        };
        saveCountdownSlots();
        updateAll();
        sendSlotsToInspector(msg.context);
      }

    } else if (payload.command === "deleteCountdownSlot") {
      const index = Number(payload.index);

      if (!Number.isInteger(index) || index < 0 || index >= COUNTDOWN_SLOTS.length) {
        return;
      }

      if (COUNTDOWN_SLOTS.length <= 1) {
        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { slotError: "You need at least one countdown slot." }
        });
        return;
      }

      COUNTDOWN_SLOTS.splice(index, 1);
      saveCountdownSlots();

      // Re-point any buttons that used the deleted slot or a later one.
      for (const [ctx, entry] of contexts.entries()) {
        let next = entry.slotIndex;
        if (next === index) next = 0;
        else if (next > index) next -= 1;

        if (next !== entry.slotIndex) {
          entry.slotIndex = next;
          persistEntry(ctx);
        }
      }

      updateAll();
      sendSlotsToInspector(msg.context);
    }

  } else if (msg.event === "willAppear") {
    if (!PARTS[msg.action]) return;

    const settings = msg.payload?.settings || {};
    contexts.set(msg.context, {
      uuid: msg.action,
      controller: msg.payload?.controller || "Encoder",
      slotIndex: clampSlotIndex(settings.slotIndex),
      backgroundColor: settings.backgroundColor || DEFAULT_COLORS.backgroundColor,
      numberColor: settings.numberColor || DEFAULT_COLORS.numberColor,
      labelColor: settings.labelColor || DEFAULT_COLORS.labelColor,
      labelSize: settings.labelSize || DEFAULT_FONT.labelSize,
      numberSize: settings.numberSize || DEFAULT_FONT.numberSize,
      units: normalizeUnits(settings.units, msg.action),
      reachedText: normalizeReachedText(settings.reachedText)
    });
    updateContext(msg.context);

    if (!timer) {
      timer = setInterval(updateAll, 250);
    }

  } else if (msg.event === "didReceiveSettings") {
    const entry = contexts.get(msg.context);
    if (entry) {
      const settings = msg.payload?.settings || {};
      entry.slotIndex = clampSlotIndex(settings.slotIndex);
      entry.backgroundColor = settings.backgroundColor || DEFAULT_COLORS.backgroundColor;
      entry.numberColor = settings.numberColor || DEFAULT_COLORS.numberColor;
      entry.labelColor = settings.labelColor || DEFAULT_COLORS.labelColor;
      entry.labelSize = settings.labelSize || DEFAULT_FONT.labelSize;
      entry.numberSize = settings.numberSize || DEFAULT_FONT.numberSize;
      entry.units = normalizeUnits(settings.units, entry.uuid);
      entry.reachedText = normalizeReachedText(settings.reachedText);
      updateContext(msg.context);
    }

  } else if (msg.event === "willDisappear") {
    contexts.delete(msg.context);

    if (contexts.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
}

function valuesForTarget(targetMs) {
  const remaining = Math.max(0, targetMs - Date.now());
  const total = Math.floor(remaining / 1000);
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60
  };
}

function valuesForUnits(targetMs, units) {
  let rest = Math.floor(Math.max(0, targetMs - Date.now()) / 1000);
  const values = {};
  for (const unit of UNIT_ORDER) {
    if (!units.includes(unit)) continue;
    values[unit] = Math.floor(rest / UNIT_SECONDS[unit]);
    rest -= values[unit] * UNIT_SECONDS[unit];
  }
  return values;
}

// e.g. "12d 03:45:10", "12d 03h", "36:20" or just "5" for a single unit.
function formatUnits(values, units) {
  const pad = n => String(n).padStart(2, "0");
  if (units.length === 1) return String(values[units[0]]);

  const hasDays = units[0] === "days";
  const rest = hasDays ? units.slice(1) : units;
  const idx = rest.map(u => UNIT_ORDER.indexOf(u));
  const contiguous = rest.length >= 2 && idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const parts = [];

  if (hasDays) parts.push(`${values.days}d`);
  if (contiguous) {
    parts.push(rest.map((u, i) => (i === 0 && !hasDays ? String(values[u]) : pad(values[u]))).join(":"));
  } else {
    rest.forEach((u, i) => {
      const v = i === 0 && !hasDays ? String(values[u]) : pad(values[u]);
      parts.push(`${v}${u[0]}`);
    });
  }
  return parts.join(" ");
}

function labelForUnits(units) {
  if (units.length === 1) return UNIT_LABELS[units[0]];
  return units.map(u => UNIT_SHORT_LABELS[u]).join(" : ");
}

function updateContext(context) {
  const entry = contexts.get(context);
  if (!entry) return;

  const part = PARTS[entry.uuid];
  if (!part) return;

  const colors = {
    backgroundColor: entry.backgroundColor || DEFAULT_COLORS.backgroundColor,
    numberColor: entry.numberColor || DEFAULT_COLORS.numberColor,
    labelColor: entry.labelColor || DEFAULT_COLORS.labelColor
  };

  const font = {
    labelSize: entry.labelSize || DEFAULT_FONT.labelSize,
    numberSize: entry.numberSize || DEFAULT_FONT.numberSize
  };

  const targetMs = getSlotTargetMs(entry.slotIndex);
  const reachedText = normalizeReachedText(entry.reachedText);
  const reached = reachedText !== "" && targetMs - Date.now() <= 0;
  let display;
  let label = part.label;

  if (reached) {
    display = reachedText;
    label = "";
  } else if (part.kind === "custom") {
    const units = normalizeUnits(entry.units, entry.uuid);
    display = formatUnits(valuesForUnits(targetMs, units), units);
    label = labelForUnits(units);
  } else {
    const v = valuesForTarget(targetMs);
    switch (part.kind) {
      case "days":
        display = String(v.days);
        break;
      case "hours":
        display = String(v.hours).padStart(2, "0");
        break;
      case "minutes":
        display = String(v.minutes).padStart(2, "0");
        break;
      default:
        display = String(v.seconds).padStart(2, "0");
    }
  }

  if (entry.controller === "Keypad") {
    const labelFit = fitText(label, Math.min(font.labelSize, 28), 128);
    const numberFit = fitText(display, Math.min(font.numberSize, 54), 128, reached ? 12 : 14);
    const fitAttr = fit => (fit.squeeze ? ' textLength="128" lengthAdjust="spacingAndGlyphs"' : "");

    const background = `<rect width="144" height="144" rx="12" fill="${colors.backgroundColor}"/>`;
    const labelText = label
      ? `<text x="72" y="43" text-anchor="middle"${fitAttr(labelFit)} font-family="Arial, sans-serif" font-size="${labelFit.size}" font-weight="600" fill="${colors.labelColor}">${escapeXml(label)}</text>`
      : "";
    const numberY = reached ? 72 + Math.round(numberFit.size * 0.35) : 105;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144">
        ${background}
        ${labelText}
        <text x="72" y="${numberY}" text-anchor="middle"${fitAttr(numberFit)} font-family="Arial, sans-serif" font-size="${numberFit.size}" font-weight="700" fill="${colors.numberColor}">${escapeXml(display)}</text>
      </svg>`;

    send({
      event: "setImage",
      context,
      payload: {
        image: "data:image/svg+xml;charset=utf8," + encodeURIComponent(svg),
        target: 0,
        state: 0
      }
    });

    return;
  }

  send({
    event: "setFeedbackLayout",
    context,
    payload: { layout: "countdown.json" }
  });

  send({
    event: "setFeedback",
    context,
    payload: {
      label: {
        value: label,
        font: { size: fitText(label, font.labelSize, 190).size }
      },
      value: {
        value: display,
        font: { size: fitText(display, font.numberSize, 190).size }
      }
    }
  });
}

function updateAll() {
  for (const context of contexts.keys()) updateContext(context);
}

startConnection();
