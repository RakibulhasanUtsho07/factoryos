const EPC_HEX_PATTERN = /^[0-9A-F]{16,128}$/;
const EPC_PREFIX_PATTERN = /^(?:EPC|TAG)\s*[:=]\s*/i;

export class RfidReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RfidReaderError";
    this.code = code;
  }
}

/**
 * EPC Gen2 tag identifiers are consumed as hex payloads. Separators inserted
 * by some serial readers are normalized, but arbitrary status lines are not
 * interpreted as tag reads.
 */
export function normalizeEpc(rawValue) {
  if (typeof rawValue !== "string") {
    throw new RfidReaderError("INVALID_EPC_TYPE", "EPC must be text.");
  }
  const withoutPrefix = rawValue.trim().replace(EPC_PREFIX_PATTERN, "");
  const epc = withoutPrefix.replace(/[\s:-]/g, "").toUpperCase();
  if (!EPC_HEX_PATTERN.test(epc) || epc.length % 2 !== 0) {
    throw new RfidReaderError("INVALID_EPC", "Reader output must contain an even-length hexadecimal EPC from 16 to 128 characters.");
  }
  return epc;
}

function getEpcFromStructuredLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed.epc ?? parsed.EPC ?? parsed.tagEpc ?? parsed.tag_epc ?? null;
    }
  } catch {
    // Reader may emit a plain EPC line instead of JSON.
  }
  return null;
}

/**
 * Parses one newline-delimited serial-reader record. Accepted formats are a
 * bare EPC, EPC:<hex>, EPC=<hex>, TAG:<hex>, or JSON with an epc property.
 * RSSI, timestamps, reader health, and vendor status frames are ignored unless
 * the configured reader integration emits an EPC in one of these forms.
 */
export function parseRfidReaderLine(rawLine) {
  if (typeof rawLine !== "string") return null;
  const line = rawLine.replace(/^\uFEFF/, "").trim();
  if (!line) return null;
  const structured = getEpcFromStructuredLine(line);
  const candidate = structured === null ? line : String(structured);
  try {
    return normalizeEpc(candidate);
  } catch {
    return null;
  }
}

/** Retain every read for server-side duplicate suppression and reconciliation. */
export function aggregateEpcReads(reads) {
  if (!Array.isArray(reads)) throw new RfidReaderError("INVALID_READS", "EPC reads must be an array.");
  const counts = new Map();
  for (const value of reads) {
    const epc = normalizeEpc(value);
    counts.set(epc, (counts.get(epc) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([epc, readCount]) => ({ epc, readCount, duplicateCount: readCount - 1 }));
}

export function getWebSerialProvider() {
  if (typeof navigator === "undefined") return null;
  return navigator.serial ?? null;
}

export class WebSerialRfidReader {
  constructor(options = {}) {
    this.serialProvider = options.serialProvider ?? getWebSerialProvider();
    this.port = null;
    this.reader = null;
    this.running = false;
    this.readTask = null;
  }

  get connected() {
    return this.running && this.port !== null;
  }

  async connect(options = {}) {
    if (this.connected || this.port) {
      throw new RfidReaderError("READER_ALREADY_CONNECTED", "Disconnect the current reader before reconnecting.");
    }
    if (!this.serialProvider || typeof this.serialProvider.requestPort !== "function") {
      throw new RfidReaderError("WEB_SERIAL_UNAVAILABLE", "This browser does not expose Web Serial. Use Chromium over HTTPS or an approved vendor SDK/gateway.");
    }
    const baudRate = Number(options.baudRate ?? 115200);
    if (!Number.isInteger(baudRate) || baudRate < 300 || baudRate > 4_000_000) {
      throw new RfidReaderError("INVALID_BAUD_RATE", "Serial baud rate must be an integer between 300 and 4,000,000.");
    }
    const port = await this.serialProvider.requestPort();
    this.port = port;
    try {
      await port.open({ baudRate });
      if (!port.readable || typeof port.readable.getReader !== "function") {
        throw new RfidReaderError("SERIAL_STREAM_UNAVAILABLE", "Selected serial port has no readable stream.");
      }
      this.reader = port.readable.getReader();
      this.running = true;
      options.onStatus?.({ connected: true, baudRate });
      this.readTask = this.consume(options);
      return { connected: true, baudRate };
    } catch (error) {
      this.running = false;
      this.reader = null;
      this.port = null;
      try { await port.close(); } catch { /* port may not have opened */ }
      throw error;
    }
  }

  async consume(options) {
    const reader = this.reader;
    const decoder = new TextDecoder();
    let buffer = "";
    const processLine = (line) => {
      if (!line.trim()) return;
      const epc = parseRfidReaderLine(line);
      if (epc) {
        options.onEpc?.(epc);
      } else {
        options.onInvalidLine?.({ line: line.slice(0, 256), code: "IGNORED_READER_FRAME" });
      }
    };
    try {
      while (this.running && reader) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/[\r\n]+/);
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      }
      buffer += decoder.decode();
      if (buffer.trim()) processLine(buffer);
    } catch (error) {
      if (this.running) {
        options.onError?.(error instanceof Error ? error : new Error("RFID serial read failed."));
      }
    } finally {
      this.running = false;
      if (this.reader === reader) this.reader = null;
      if (reader) {
        try { reader.releaseLock(); } catch { /* already released by disconnect */ }
      }
      const port = this.port;
      this.port = null;
      if (port) {
        try { await port.close(); } catch { /* disconnected hardware can fail to close */ }
      }
      options.onStatus?.({ connected: false, baudRate: Number(options.baudRate ?? 115200) });
    }
  }

  async disconnect() {
    this.running = false;
    const reader = this.reader;
    if (reader) {
      try { await reader.cancel(); } catch { /* reader may have disconnected */ }
    }
    if (this.readTask) {
      await this.readTask;
      this.readTask = null;
    } else if (this.port) {
      const port = this.port;
      this.port = null;
      try { await port.close(); } catch { /* best-effort close */ }
    }
  }

  async waitUntilStopped() {
    if (this.readTask) await this.readTask;
  }
}
