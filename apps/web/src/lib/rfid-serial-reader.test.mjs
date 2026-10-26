import test from "node:test";
import assert from "node:assert/strict";

import {
  RfidReaderError,
  WebSerialRfidReader,
  aggregateEpcReads,
  normalizeEpc,
  parseRfidReaderLine,
} from "./rfid-serial-reader.mjs";

const EPC_A = "300833B2DDD9014000000001";
const EPC_B = "E280689400005020A1234567";

test("normalizes hexadecimal EPCs and reader separators without changing tag identity", () => {
  assert.equal(normalizeEpc("  epc: 3008 33b2 ddd9 0140 0000 0001  "), EPC_A);
  assert.equal(normalizeEpc("TAG=E2:80:68:94:00:00:50:20:A1:23:45:67"), EPC_B);
  assert.throws(() => normalizeEpc("not-an-epc"), (error) => error instanceof RfidReaderError && error.code === "INVALID_EPC");
  assert.throws(() => normalizeEpc("ABC"), (error) => error instanceof RfidReaderError && error.code === "INVALID_EPC");
  assert.throws(() => normalizeEpc("300833B2DDD901400000000Z"), (error) => error instanceof RfidReaderError && error.code === "INVALID_EPC");
  assert.throws(() => normalizeEpc("300833B2DDD9014000000001" + "A".repeat(108)), (error) => error instanceof RfidReaderError && error.code === "INVALID_EPC");
});

test("parses raw EPC, prefixed EPC and JSON reader frames; ignores status, RSSI and malformed lines", () => {
  assert.equal(parseRfidReaderLine(EPC_A.toLowerCase()), EPC_A);
  assert.equal(parseRfidReaderLine("EPC:" + EPC_A), EPC_A);
  assert.equal(parseRfidReaderLine("tag=" + EPC_B), EPC_B);
  assert.equal(parseRfidReaderLine('{"epc":"' + EPC_A.toLowerCase() + '","rssi":-42}'), EPC_A);
  assert.equal(parseRfidReaderLine('{"EPC":"' + EPC_B + '"}'), EPC_B);
  assert.equal(parseRfidReaderLine("Inventory started"), null);
  assert.equal(parseRfidReaderLine("RSSI:-45"), null);
  assert.equal(parseRfidReaderLine(""), null);
  assert.equal(parseRfidReaderLine(null), null);
});

test("aggregates canonical EPC repeats without discarding server-side duplicate evidence", () => {
  const summary = aggregateEpcReads([EPC_A, EPC_A.toLowerCase(), "EPC:" + EPC_A, EPC_B]);
  assert.deepEqual(summary, [
    { epc: EPC_A, readCount: 3, duplicateCount: 2 },
    { epc: EPC_B, readCount: 1, duplicateCount: 0 },
  ]);
});

test("Web Serial reader opens a real port stream and forwards EPC frames while ignoring non-tag frames", async () => {
  const encoder = new TextEncoder();
  const chunks = [
    "EPC:" + EPC_A + "\r\n",
    "RSSI:-42\r\n" + '{"epc":"' + EPC_B + '","rssi":-39}' + "\n",
    "Inventory started\r\n" + EPC_A.toLowerCase() + "\r\n",
  ];
  const readable = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const events = [];
  let openedWith = null;
  let closeCount = 0;
  const port = {
    readable,
    async open(options) { openedWith = options; },
    async close() { closeCount += 1; },
  };
  const serialProvider = { async requestPort() { return port; } };
  const reader = new WebSerialRfidReader({ serialProvider });
  const reads = [];
  const ignored = [];
  const states = [];
  await reader.connect({
    baudRate: 115200,
    onEpc: (epc) => reads.push(epc),
    onInvalidLine: (frame) => ignored.push(frame),
    onStatus: (state) => states.push(state.connected),
    onError: (error) => events.push(error.message),
  });
  await reader.waitUntilStopped();
  assert.deepEqual(openedWith, { baudRate: 115200 });
  assert.deepEqual(reads, [EPC_A, EPC_B, EPC_A]);
  assert.equal(ignored.length, 2);
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(events, []);
  assert.equal(closeCount, 1);
  assert.equal(reader.connected, false);
});

test("does not accept a partial EPC that has no line terminator", async () => {
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(EPC_A));
      controller.close();
    },
  });
  const port = {
    readable,
    async open() {},
    async close() {},
  };
  const reader = new WebSerialRfidReader({ serialProvider: { async requestPort() { return port; } } });
  const reads = [];
  const ignored = [];
  await reader.connect({
    onEpc: (epc) => reads.push(epc),
    onInvalidLine: (frame) => ignored.push(frame),
  });
  await reader.waitUntilStopped();
  assert.deepEqual(reads, []);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].code, "INCOMPLETE_READER_FRAME");
});

test("Web Serial adapter rejects missing browser support and invalid baud rates", async () => {
  const unsupported = new WebSerialRfidReader({ serialProvider: null });
  await assert.rejects(
    unsupported.connect(),
    (error) => error instanceof RfidReaderError && error.code === "WEB_SERIAL_UNAVAILABLE",
  );
  const provider = { async requestPort() { throw new Error("should not request port"); } };
  const reader = new WebSerialRfidReader({ serialProvider: provider });
  await assert.rejects(
    reader.connect({ baudRate: 0 }),
    (error) => error instanceof RfidReaderError && error.code === "INVALID_BAUD_RATE",
  );
});

test("reader can reconnect after disconnect and starts a fresh serial session", async () => {
  const encoder = new TextEncoder();
  const ports = [];
  const provider = {
    async requestPort() {
      const next = ports.shift();
      if (!next) throw new Error("No test port available.");
      return next;
    },
  };
  function controllablePort() {
    let controller;
    let closeCount = 0;
    const port = {
      readable: new ReadableStream({
        start(value) { controller = value; },
      }),
      async open() {},
      async close() { closeCount += 1; },
      emit(line) { controller.enqueue(encoder.encode(line)); },
      get closeCount() { return closeCount; },
    };
    return port;
  }

  const firstPort = controllablePort();
  const secondPort = controllablePort();
  ports.push(firstPort, secondPort);
  const reader = new WebSerialRfidReader({ serialProvider: provider });
  const reads = [];
  let firstReadResolve;
  const firstRead = new Promise((resolve) => { firstReadResolve = resolve; });
  await reader.connect({
    baudRate: 9600,
    onEpc: (epc) => {
      reads.push(epc);
      if (epc === EPC_A) firstReadResolve();
    },
  });
  firstPort.emit(EPC_A + "\\r\\n");
  await firstRead;
  await reader.disconnect();
  assert.equal(firstPort.closeCount, 1);
  assert.equal(reader.connected, false);

  let secondReadResolve;
  const secondRead = new Promise((resolve) => { secondReadResolve = resolve; });
  await reader.connect({
    baudRate: 9600,
    onEpc: (epc) => {
      reads.push(epc);
      if (epc === EPC_B) secondReadResolve();
    },
  });
  secondPort.emit(EPC_B + "\\n");
  await secondRead;
  await reader.disconnect();

  assert.deepEqual(reads, [EPC_A, EPC_B]);
  assert.equal(secondPort.closeCount, 1);
  assert.equal(reader.connected, false);
});
