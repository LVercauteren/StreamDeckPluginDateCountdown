const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_TARGET_MS = Date.parse("2026-11-04T15:00:00-08:00");
const TARGET_FILE = path.join(__dirname, "target-date.json");
const COUNTDOWN_FILE = path.join(__dirname, "countdowns.json");
const FONT_FILE = path.join(__dirname, "font-settings.json");
const COLOR_FILE = path.join(__dirname, "color-settings.json");

const DEFAULT_COLORS = {
  backgroundColor: "#111827",
  numberColor: "#FFFFFF",
  labelColor: "#D8D8DC"
};

const DEFAULT_FONT = {
  labelSize: 18,
  numberSize: 40
};

let DIAL_COLORS = { ...DEFAULT_COLORS };
let KEYPAD_COLORS = {};
let DIAL_FONT = { ...DEFAULT_FONT };
let KEYPAD_FONT = {};

const BACKGROUND_FILE = path.join(__dirname, "keypad-background.json");
const MAX_BACKGROUND_SIZE = 2 * 1024 * 1024;

let KEYPAD_BACKGROUND = null;

loadKeypadBackground();

let pluginId = null;

const PARTS = {
  "com.wowforever.countdown.days": { label: "DAYS", kind: "days" },
  "com.wowforever.countdown.hours": { label: "HOURS", kind: "hours" },
  "com.wowforever.countdown.minutes": { label: "MINUTES", kind: "minutes" },
  "com.wowforever.countdown.seconds": { label: "SECONDS", kind: "seconds" }
};

function loadKeypadBackground() {
  try {
    const data = JSON.parse(fs.readFileSync(BACKGROUND_FILE, "utf8"));

    if (
      ["image/png", "image/jpeg", "image/webp"].includes(data.mime) &&
      typeof data.base64 === "string" &&
      data.base64.length > 0 &&
      data.base64.length <= Math.ceil(MAX_BACKGROUND_SIZE * 4 / 3)
    ) {
      KEYPAD_BACKGROUND = data;
      return;
    }
  } catch { }

  KEYPAD_BACKGROUND = null;
}

function loadFontSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(FONT_FILE, "utf8"));

    if (data.dials && typeof data.dials === "object") {
      const labelSize = Number(data.dials.labelSize);
      const numberSize = Number(data.dials.numberSize);
      if (
        Number.isFinite(labelSize) &&
        labelSize >= 12 && labelSize <= 60 &&
        Number.isFinite(numberSize) &&
        numberSize >= 12 && numberSize <= 60
      ) {
        DIAL_FONT = { labelSize, numberSize };
      }
    }

    if (data.keypad && typeof data.keypad === "object") {
      const loadedKeypadFont = {};
      for (const [action, values] of Object.entries(data.keypad)) {
        if (!values || typeof values !== "object") continue;
        const labelSize = Number(values.labelSize);
        const numberSize = Number(values.numberSize);
        if (
          Number.isFinite(labelSize) &&
          labelSize >= 12 && labelSize <= 60 &&
          Number.isFinite(numberSize) &&
          numberSize >= 12 && numberSize <= 60
        ) {
          loadedKeypadFont[action] = { labelSize, numberSize };
        }
      }
      KEYPAD_FONT = loadedKeypadFont;
    }
  } catch {
    DIAL_FONT = { ...DEFAULT_FONT };
    KEYPAD_FONT = {};
  }
}

loadFontSettings();

function loadColorSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(COLOR_FILE, "utf8"));

    if (data.dials && typeof data.dials === "object") {
      DIAL_COLORS = { ...DEFAULT_COLORS, ...data.dials };
    }

    if (data.keypad && typeof data.keypad === "object") {
      KEYPAD_COLORS = data.keypad;
    }
  } catch {
    DIAL_COLORS = { ...DEFAULT_COLORS };
    KEYPAD_COLORS = {};
  }
}

loadColorSettings();

// ---------------------------------------------------------------------------
// Countdown slots (global list, each button/dial picks one by index)
// ---------------------------------------------------------------------------

function loadLegacyTargetMs() {
  try {
    const data = JSON.parse(fs.readFileSync(TARGET_FILE, "utf8"));
    const savedTarget = Date.parse(data.targetDate || "");
    if (Number.isFinite(savedTarget) && savedTarget > 0) return savedTarget;
  } catch { }
  return DEFAULT_TARGET_MS;
}

function defaultSlots() {
  return [
    { name: "Countdown", targetDate: new Date(loadLegacyTargetMs()).toISOString() }
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
          targetDate: new Date(Date.parse(slot.targetDate)).toISOString()
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
    process.stderr.write("WoW Forever Countdown: missing Stream Deck startup arguments\n");
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

function persistSlotIndex(context, slotIndex) {
  send({
    event: "setSettings",
    context,
    payload: { slotIndex }
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

    if (payload.command === "getBackgroundSettings") {
      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: {
          backgroundDataUrl: KEYPAD_BACKGROUND
            ? `data:${KEYPAD_BACKGROUND.mime};base64,${KEYPAD_BACKGROUND.base64}`
            : null
        }
      });

    } else if (payload.command === "saveBackground") {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
        payload.backgroundDataUrl || ""
      );

      if (!match) {
        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { backgroundError: "Choose a valid PNG, JPG, or WebP image." }
        });
      } else {
        const imageBuffer = Buffer.from(match[2], "base64");

        if (
          imageBuffer.length === 0 ||
          imageBuffer.length > MAX_BACKGROUND_SIZE
        ) {
          send({
            event: "sendToPropertyInspector",
            context: msg.context,
            payload: { backgroundError: "The image must be smaller than 2 MB." }
          });
        } else {
          KEYPAD_BACKGROUND = {
            mime: match[1],
            base64: imageBuffer.toString("base64")
          };

          try {
            fs.writeFileSync(
              BACKGROUND_FILE,
              JSON.stringify(KEYPAD_BACKGROUND),
              "utf8"
            );
          } catch (error) {
            send({
              event: "sendToPropertyInspector",
              context: msg.context,
              payload: { backgroundError: "Could not save the image: " + error.message }
            });
            return;
          }

          updateAll();

          send({
            event: "sendToPropertyInspector",
            context: msg.context,
            payload: { backgroundSaved: true }
          });
        }
      }

    } else if (payload.command === "resetBackground") {
      try {
        fs.unlinkSync(BACKGROUND_FILE);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      KEYPAD_BACKGROUND = null;
      updateAll();

      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: { backgroundReset: true }
      });

    } else if (payload.command === "getColorSettings") {
      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: {
          dialColors: DIAL_COLORS,
          keypadColors: KEYPAD_COLORS
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
        const controller = payload.controller;
        const action = payload.action;

        if (controller === "Keypad" && PARTS[action]) {
          KEYPAD_COLORS[action] = { ...colors };
        } else {
          DIAL_COLORS = { ...colors };
        }

        fs.writeFileSync(
          COLOR_FILE,
          JSON.stringify({
            dials: DIAL_COLORS,
            keypad: KEYPAD_COLORS
          }, null, 2),
          "utf8"
        );

        updateAll();

        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { colorsSaved: true }
        });
      } else {
        send({
          event: "sendToPropertyInspector",
          context: msg.context,
          payload: { colorsError: "Please choose valid colors." }
        });
      }

    } else if (payload.command === "getFontSettings") {
      const targetController = payload.controller || "Encoder";
      const targetAction = payload.action || null;
      const font =
        targetController === "Keypad" && targetAction && PARTS[targetAction]
          ? (KEYPAD_FONT[targetAction] || DIAL_FONT)
          : DIAL_FONT;

      send({
        event: "sendToPropertyInspector",
        context: msg.context,
        payload: {
          labelSize: font.labelSize,
          numberSize: font.numberSize
        }
      });

    } else if (payload.command === "saveFontSettings") {
      const labelSize = Number(payload.labelSize);
      const numberSize = Number(payload.numberSize);
      const controller = payload.controller || "Encoder";
      const action = payload.action || null;

      if (
        Number.isFinite(labelSize) &&
        labelSize >= 12 && labelSize <= 60 &&
        Number.isFinite(numberSize) &&
        numberSize >= 12 && numberSize <= 60
      ) {
        if (controller === "Keypad" && action && PARTS[action]) {
          KEYPAD_FONT[action] = { labelSize, numberSize };
        } else {
          DIAL_FONT = { labelSize, numberSize };
        }

        fs.writeFileSync(
          FONT_FILE,
          JSON.stringify({ dials: DIAL_FONT, keypad: KEYPAD_FONT }, null, 2),
          "utf8"
        );

        updateAll();

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

    } else if (payload.command === "getCountdownSlots") {
      sendSlotsToInspector(msg.context);

    } else if (payload.command === "selectCountdownSlot") {
      const index = Number(payload.index);
      const entry = contexts.get(msg.context);

      if (entry && Number.isInteger(index) && index >= 0 && index < COUNTDOWN_SLOTS.length) {
        entry.slotIndex = index;
        persistSlotIndex(msg.context, index);
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
        COUNTDOWN_SLOTS.push({ name, targetDate: new Date(ms).toISOString() });
        saveCountdownSlots();

        // Make this button use the newly created slot.
        const entry = contexts.get(msg.context);
        if (entry) {
          entry.slotIndex = COUNTDOWN_SLOTS.length - 1;
          persistSlotIndex(msg.context, entry.slotIndex);
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
          targetDate: new Date(ms).toISOString()
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
          persistSlotIndex(ctx, next);
        }
      }

      updateAll();
      sendSlotsToInspector(msg.context);
    }

  } else if (msg.event === "willAppear") {
    if (!PARTS[msg.action]) return;

    contexts.set(msg.context, {
      uuid: msg.action,
      controller: msg.payload?.controller || "Encoder",
      slotIndex: clampSlotIndex(msg.payload?.settings?.slotIndex)
    });
    updateContext(msg.context);

    if (!timer) {
      timer = setInterval(updateAll, 250);
    }

  } else if (msg.event === "didReceiveSettings") {
    const entry = contexts.get(msg.context);
    if (entry) {
      entry.slotIndex = clampSlotIndex(msg.payload?.settings?.slotIndex);
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

function updateContext(context) {
  const entry = contexts.get(context);
  if (!entry) return;

  const part = PARTS[entry.uuid];
  if (!part) return;

  const colors = entry.controller === "Keypad"
    ? (KEYPAD_COLORS[entry.uuid] || DEFAULT_COLORS)
    : DIAL_COLORS;

  const font = entry.controller === "Keypad"
    ? (KEYPAD_FONT[entry.uuid] || DIAL_FONT)
    : DIAL_FONT;

  const v = valuesForTarget(getSlotTargetMs(entry.slotIndex));
  let display;

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

  if (entry.controller === "Keypad") {
    const labelFontSize = Math.min(font.labelSize, 28);
    const numberFontSize = Math.min(font.numberSize, 54);

    // Stream Deck's SVG renderer needs the xlink namespace and xlink:href
    // for embedded images; a plain href is silently ignored.
    const background = KEYPAD_BACKGROUND
      ? `
        <image xlink:href="data:${KEYPAD_BACKGROUND.mime};base64,${KEYPAD_BACKGROUND.base64}" x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice"/>
        <rect width="144" height="144" fill="#000000" fill-opacity="0.25"/>
      `
      : `<rect width="144" height="144" rx="12" fill="${colors.backgroundColor}"/>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="144" height="144" viewBox="0 0 144 144">
        ${background}
        <text x="72" y="43" text-anchor="middle" font-family="Arial, sans-serif" font-size="${labelFontSize}" font-weight="600" fill="${colors.labelColor}">${part.label}</text>
        <text x="72" y="105" text-anchor="middle" textLength="120" lengthAdjust="spacingAndGlyphs" font-family="Arial, sans-serif" font-size="${numberFontSize}" font-weight="700" fill="${colors.numberColor}">${display}</text>
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
        value: part.label,
        font: { size: font.labelSize }
      },
      value: {
        value: display,
        font: { size: font.numberSize }
      }
    }
  });
}

function updateAll() {
  for (const context of contexts.keys()) updateContext(context);
}

startConnection();
