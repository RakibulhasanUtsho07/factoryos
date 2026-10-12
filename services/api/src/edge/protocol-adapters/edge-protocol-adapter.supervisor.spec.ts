import { jest } from '@jest/globals';

import type { EdgeSpoolBatch } from '../spool/durable-edge-spool.js';
import type { EdgeModbusReadSample, EdgeMqttMessage, EdgeOpcUaDataValue, ModbusSignalMapping } from './edge-protocol-adapter.types.js';
import { EdgeProtocolAdapterSupervisor } from './edge-protocol-adapter.supervisor.js';
import { MqttEdgeProtocolAdapter } from './mqtt-edge-protocol.adapter.js';
import { OpcUaEdgeProtocolAdapter } from './opcua-edge-protocol.adapter.js';
import { ModbusEdgeProtocolAdapter } from './modbus-edge-protocol.adapter.js';

function sink() {
  return {
    enqueue: jest.fn(async (input: unknown) => {
      const batch = input as EdgeSpoolBatch;
      return { idempotent: false, batchKey: batch.batch_key };
    }),
  };
}

describe('EdgeProtocolAdapterSupervisor', () => {
  it('starts and stops pre-authorized MQTT, OPC UA, and Modbus bindings together', async () => {
    const mqttTransport = {
      subscribe: jest.fn(async (_topic: string, _handler: (message: EdgeMqttMessage) => void) =>
        jest.fn<() => void>()),
    };
    const opcuaTransport = {
      subscribe: jest.fn(async (_nodeId: string, _handler: (value: EdgeOpcUaDataValue) => void) =>
        jest.fn<() => void>()),
    };
    const mqtt = new MqttEdgeProtocolAdapter([{
      topic: 'site/line/temp',
      signalKey: 'line.temperature',
      unit: 'degC',
      samplingIntervalMs: 1000,
      valueField: 'value',
      timestampField: 'observed_at',
    }], sink());
    const opcua = new OpcUaEdgeProtocolAdapter([{
      nodeId: 'ns=2;s=Line1.Temperature',
      signalKey: 'line.temperature.ua',
      unit: 'degC',
      samplingIntervalMs: 1000,
    }], sink());
    const modbusTransport = {
      watch: jest.fn(async (_mapping: Readonly<ModbusSignalMapping>, _handler: (sample: EdgeModbusReadSample) => void) =>
        jest.fn<() => void>()),
    };
    const modbus = new ModbusEdgeProtocolAdapter([{
      sourceIdentifier: 'plc-line-1', unitId: 7, functionCode: 3, address: 100,
      dataType: 'UINT16', signalKey: 'line.pressure', unit: 'kPa', samplingIntervalMs: 1000,
    }], sink());
    const onError = jest.fn<(error: Error) => void>();
    const supervisor = new EdgeProtocolAdapterSupervisor([
      { protocol: 'MQTT', adapter: mqtt, transport: mqttTransport },
      { protocol: 'OPC_UA', adapter: opcua, transport: opcuaTransport },
      { protocol: 'MODBUS', adapter: modbus, transport: modbusTransport },
    ], () => 'EDGE_OFFLINE', onError);

    await supervisor.start();
    expect(mqttTransport.subscribe).toHaveBeenCalledTimes(1);
    expect(opcuaTransport.subscribe).toHaveBeenCalledTimes(1);
    expect(modbusTransport.watch).toHaveBeenCalledTimes(1);
    await supervisor.start();
    expect(mqttTransport.subscribe).toHaveBeenCalledTimes(1);

    await supervisor.stop();
    expect(onError).not.toHaveBeenCalled();
  });

  it('rolls back Modbus watches when a later protocol binding fails', async () => {
    const unsubscribe = jest.fn<() => void>();
    const modbusTransport = {
      watch: jest.fn(async (_mapping: Readonly<ModbusSignalMapping>, _handler: (sample: EdgeModbusReadSample) => void) => unsubscribe),
    };
    const opcuaTransport = {
      subscribe: jest.fn(async (_nodeId: string, _handler: (value: EdgeOpcUaDataValue) => void) => {
        throw new Error('OPC UA subscription failed after Modbus started');
      }),
    };
    const modbus = new ModbusEdgeProtocolAdapter([{
      sourceIdentifier: 'plc-line-1', unitId: 7, functionCode: 3, address: 100,
      dataType: 'UINT16', signalKey: 'line.pressure', unit: 'kPa', samplingIntervalMs: 1000,
    }], sink());
    const opcua = new OpcUaEdgeProtocolAdapter([{
      nodeId: 'ns=2;s=Line1.Temperature', signalKey: 'line.temperature.ua', unit: 'degC', samplingIntervalMs: 1000,
    }], sink());
    const supervisor = new EdgeProtocolAdapterSupervisor([
      { protocol: 'MODBUS', adapter: modbus, transport: modbusTransport },
      { protocol: 'OPC_UA', adapter: opcua, transport: opcuaTransport },
    ], () => 'EDGE_OFFLINE', () => undefined);
    await expect(supervisor.start()).rejects.toThrow('OPC UA subscription failed after Modbus started');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await supervisor.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rolls back already-started bindings when a later protocol cannot subscribe', async () => {
    const mqttUnsubscribe = jest.fn<() => void>();
    const mqttTransport = {
      subscribe: jest.fn(async (_topic: string, _handler: (message: EdgeMqttMessage) => void) =>
        mqttUnsubscribe),
    };
    const opcuaTransport = {
      subscribe: jest.fn(async (_nodeId: string, _handler: (value: EdgeOpcUaDataValue) => void) => {
        throw new Error('OPC UA subscription failed');
      }),
    };
    const mqtt = new MqttEdgeProtocolAdapter([{
      topic: 'site/line/temp',
      signalKey: 'line.temperature',
      unit: 'degC',
      samplingIntervalMs: 1000,
      valueField: 'value',
      timestampField: 'observed_at',
    }], sink());
    const opcua = new OpcUaEdgeProtocolAdapter([{
      nodeId: 'ns=2;s=Line1.Temperature',
      signalKey: 'line.temperature.ua',
      unit: 'degC',
      samplingIntervalMs: 1000,
    }], sink());
    const supervisor = new EdgeProtocolAdapterSupervisor([
      { protocol: 'MQTT', adapter: mqtt, transport: mqttTransport },
      { protocol: 'OPC_UA', adapter: opcua, transport: opcuaTransport },
    ], () => 'EDGE_OFFLINE', () => undefined);

    await expect(supervisor.start()).rejects.toThrow('OPC UA subscription failed');
    expect(mqttUnsubscribe).toHaveBeenCalledTimes(1);
    await supervisor.stop();
    expect(mqttUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
