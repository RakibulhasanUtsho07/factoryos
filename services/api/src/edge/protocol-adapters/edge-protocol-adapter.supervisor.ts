import type {
  EdgeMqttTransport,
  EdgeOpcUaTransport,
  EdgeProtocolSourceMode,
} from './edge-protocol-adapter.types.js';
import { MqttEdgeProtocolAdapter } from './mqtt-edge-protocol.adapter.js';
import { OpcUaEdgeProtocolAdapter } from './opcua-edge-protocol.adapter.js';

export type EdgeProtocolAdapterBinding =
  | {
      protocol: 'MQTT';
      adapter: MqttEdgeProtocolAdapter;
      transport: EdgeMqttTransport;
    }
  | {
      protocol: 'OPC_UA';
      adapter: OpcUaEdgeProtocolAdapter;
      transport: EdgeOpcUaTransport;
    };

/**
 * Starts/stops pre-authorized transport bindings as one lifecycle. It never
 * dials endpoints or creates credentials: the hosting edge deployment owns
 * certificate verification, broker ACLs, segmentation, and transport clients.
 */
export class EdgeProtocolAdapterSupervisor {
  private readonly started: EdgeProtocolAdapterBinding[] = [];
  private running = false;

  constructor(
    private readonly bindings: readonly EdgeProtocolAdapterBinding[],
    private readonly sourceModeProvider: () => EdgeProtocolSourceMode,
    private readonly onError: (error: Error) => void,
  ) {
    if (!Array.isArray(bindings) || bindings.length > 32) {
      throw new Error('Edge protocol supervisor supports at most 32 protocol bindings');
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      for (const binding of this.bindings) {
        if (binding.protocol === 'MQTT') {
          await binding.adapter.start(binding.transport, this.sourceModeProvider, this.onError);
        } else {
          await binding.adapter.start(binding.transport, this.sourceModeProvider, this.onError);
        }
        this.started.push(binding);
      }
      this.running = true;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: Error[] = [];
    for (const binding of this.started.splice(0).reverse()) {
      try {
        await binding.adapter.stop();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error('Protocol adapter shutdown failed'));
      }
    }
    this.running = false;
    if (errors.length) {
      throw new AggregateError(errors, 'One or more edge protocol adapters could not be stopped');
    }
  }
}
