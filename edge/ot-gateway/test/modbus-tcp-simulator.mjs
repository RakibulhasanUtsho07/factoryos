import net from 'node:net';

/**
 * Small, deliberately limited Modbus TCP simulator for read-only integration
 * tests. It records rejected write attempts and can inject response loss,
 * delayed responses and a wrong unit ID. It is test support, not production code.
 */
export async function startModbusTcpSimulator(options = {}) {
  const unitId = options.unitId ?? 7;
  const registers = options.registers ?? new Map([
    ['3:30', [0x0000, 0x0064]],
    ['4:10', [0x4228, 0x0000]],
  ]);
  const faults = { dropNextResponse: false, wrongUnitId: false, delayNextMs: 0, ...(options.faults ?? {}) };
  const metrics = { reads: 0, writeAttempts: 0, malformedRequests: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 7) {
        const length = buffered.readUInt16BE(4);
        const frameLength = 6 + length;
        if (length < 2 || frameLength > 260) {
          metrics.malformedRequests += 1;
          socket.destroy();
          return;
        }
        if (buffered.length < frameLength) return;
        const request = buffered.subarray(0, frameLength);
        buffered = buffered.subarray(frameLength);
        const functionCode = request[7];
        const requestedUnit = request[6];
        if (![3, 4].includes(functionCode)) {
          metrics.writeAttempts += 1;
          const reply = Buffer.alloc(9);
          request.copy(reply, 0, 0, 4);
          reply.writeUInt16BE(3, 4);
          reply[6] = requestedUnit;
          reply[7] = functionCode | 0x80;
          reply[8] = 1; // illegal function
          socket.write(reply);
          continue;
        }
        if (requestedUnit !== unitId) {
          socket.destroy();
          continue;
        }
        const address = request.readUInt16BE(8);
        const quantity = request.readUInt16BE(10);
        const source = registers instanceof Map ? registers.get(functionCode + ':' + address) : registers[functionCode + ':' + address];
        if (!Array.isArray(source) || source.length < quantity || quantity < 1 || quantity > 125) {
          const reply = Buffer.alloc(9);
          request.copy(reply, 0, 0, 4);
          reply.writeUInt16BE(3, 4);
          reply[6] = requestedUnit;
          reply[7] = functionCode | 0x80;
          reply[8] = 2; // illegal data address
          socket.write(reply);
          continue;
        }
        metrics.reads += 1;
        if (faults.dropNextResponse) {
          faults.dropNextResponse = false;
          socket.destroy();
          continue;
        }
        const values = source.slice(0, quantity);
        const reply = Buffer.alloc(9 + values.length * 2);
        request.copy(reply, 0, 0, 4);
        reply.writeUInt16BE(3 + values.length * 2, 4);
        reply[6] = faults.wrongUnitId ? (requestedUnit === 247 ? 1 : requestedUnit + 1) : requestedUnit;
        reply[7] = functionCode;
        reply[8] = values.length * 2;
        values.forEach((word, index) => reply.writeUInt16BE(word, 9 + index * 2));
        const delayMs = faults.delayNextMs;
        faults.delayNextMs = 0;
        if (delayMs > 0) setTimeout(() => socket.write(reply), delayMs);
        else socket.write(reply);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    host: '127.0.0.1',
    port: address.port,
    metrics,
    faults,
    close: () => new Promise((resolve) => {
      let settled = false;
      let cleanupTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (cleanupTimer) clearTimeout(cleanupTimer);
        resolve();
      };
      server.close(finish);
      for (const socket of sockets) socket.destroy();
      // Do not let a simulator cleanup callback hang the node:test process.
      cleanupTimer = setTimeout(finish, 1000);
    }),
  };
}
