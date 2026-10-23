# OT MQTT, Modbus TCP, offline spool and reconnect/recovery — bounded integration slice

## Scope and evidence boundary

This slice builds on the tenant/factory-scoped OT registry (migration 148), the OPC UA gateway contract (migration 157), and introduces MQTT + Modbus TCP adapters and a reusable encrypted edge spool. It is repository implementation evidence, not signed SRS acceptance: the authoritative signed SRS/HLD/Blueprint are not present in this repository snapshot.

**Trust boundary:** the API does not connect directly to a PLC or broker. A separately deployed OT edge gateway owns industrial network sessions, MQTT subscriptions, Modbus TCP sockets, endpoint/secret resolution, broker acknowledgement and hardware-specific commissioning. The API accepts only scoped operations through a fixed authenticated gateway contract and an already-authorized factory scope.

## MQTT registration and ingestion

Example MQTT device profile (topic wildcards are intentionally disabled in this first slice):

    {
      "display_name": "Line 1 telemetry bridge",
      "device_key": "LINE-1-MQTT",
      "protocol": "MQTT",
      "connection_reference": "config://MQTT_LINE_1",
      "secret_reference": "env://OT_SECRET_MQTT_LINE_1",
      "metadata": {
        "mqtt": {
          "allowed_topics": ["factory/line-1/telemetry"],
          "qos": 1
        }
      }
    }

- Topic allowlist: 1–20 unique exact topics, maximum 256 characters. Wildcards, parent traversal, control bytes and $SYS/ topics are rejected.
- QoS 1 is required; broker redelivery is expected, so source_event_id and event fingerprint provide idempotent replay.
- Ingestion route: POST /api/ot/devices/:deviceId/mqtt/message, permission ot.mqtt.ingest. The JSON topic must exactly match the immutable device profile and message must contain source_event_id, event_type, stream_key, observed_at and normalized payload; optional source_sequence is a positive safe integer.
- The message payload limit is 4 KiB. Credential-like field names are rejected. Accepted data uses the common append-only ot_telemetry_events ledger, source-sequence cursor, replay fingerprint, late/gap classification and existing ot_device_history audit. An identical replay is acknowledged as a duplicate; a reused ID with changed contents is a conflict.
- The edge subscriber must not acknowledge its broker delivery until the message is durably queued in its local spool. It may remove the local entry only after the API responds with one accepted/duplicate outcome for that source_event_id.

## Modbus TCP registration and read

Example Modbus device profile:

    {
      "display_name": "Main energy meter",
      "device_key": "ENERGY-METER-01",
      "protocol": "MODBUS_TCP",
      "connection_reference": "config://ENERGY_METER_01",
      "secret_reference": "env://OT_SECRET_ENERGY_METER_01",
      "metadata": {
        "modbus_tcp": {
          "unit_id": 7,
          "register_map": [
            {
              "stream_key": "ACTIVE_POWER",
              "function_code": 4,
              "address": 10,
              "quantity": 2,
              "data_type": "FLOAT32",
              "word_order": "ABCD"
            }
          ]
        }
      }
    }

- 1–20 unique register definitions; only read function codes 3 (holding) and 4 (input) are accepted. Unit ID is 1–247; broadcast reads and writes are excluded. Address, quantity and supported UINT16/INT16/UINT32/INT32/FLOAT32 encoding must agree. Overlapping ranges for the same function are rejected.
- Read route: POST /api/ot/devices/:deviceId/modbus/read, permission ot.modbus.read. It accepts 1–10 stream keys from the registered map, refuses paused/non-Modbus devices and never accepts a target host, TCP port, arbitrary register address or write function from the caller.
- API sends only the registered unit ID and selected register definitions over an authenticated fixed gateway route. The gateway returns raw 16-bit words; the API validates response ID and exact stream-key set, then decodes with the registered type/word order deterministically and records each numeric sample in the OT telemetry ledger.
- Gateway configuration: FACTORYOS_OT_PROTOCOL_GATEWAY_URL must be a fixed /api/v1/modbus/read URL (HTTPS outside loopback development); FACTORYOS_OT_PROTOCOL_GATEWAY_TOKEN must contain at least 32 characters and is a deployment secret; optional FACTORYOS_OT_PROTOCOL_GATEWAY_TIMEOUT_MS is an integer from 100–5000 ms (default 3500). Redirects are disabled; endpoint overrides are impossible through request JSON; response bodies are capped at 16 KiB.
- No Modbus write, coil write, broadcast, arbitrary node/register discovery or caller-selected destination is exposed.

## Offline spool format and replay invariants

The API-side contract/recovery library lives in services/api/src/ot/ot-edge-spool.store.ts and ot-edge-replay.transport.ts. The deployable long-running edge process uses edge/ot-gateway/src/spool.mjs and edge/ot-gateway/src/index.mjs; both enforce encrypted durable delivery, with the gateway runtime supplying the permanent replay supervisor:

- AES-256-GCM authenticated encryption with a fresh random 96-bit IV and an injected 32-byte key. The key must be mounted from an OS/deployment secret store and must never be written beside the spool.
- Durable atomic file replacement using a restrictive 0700 directory and 0600 data/temp-file permissions, file sync and directory sync. A corrupted, truncated or wrong-key file fails closed; it is not reset to an empty queue.
- Bounded defaults: 10,000 events, 64 MiB plaintext and event payload limit of 4 KiB. Queue-full returns an error instead of dropping the oldest data; an edge MQTT subscriber must stop acknowledging broker messages at this boundary and raise an operational alarm.
- Per-device FIFO queue selection avoids an offline device blocking another device's backlog. Replay batches are capped at 20 events; retry delay doubles from 1 second to 60 seconds maximum. After 12 consecutive transport/ack failures, the entry is marked blocked rather than removed, and the device FIFO remains blocked while other devices continue. A successful API response must confirm every queued source ID, including DUPLICATE_REPLAY, before the spool entry is removed. Partial, malformed or unrelated acknowledgements retain the batch.
- Same source ID plus identical fingerprint is deduplicated; a different body with the same ID is rejected. Persisted records are re-validated on recovery. The implementation expects one writer process per file; use separate spool files for separate gateway processes.
- The API-side OtSpoolReplayer.flushOnce remains a bounded library operation. The standalone edge gateway has a persistent reconnect/replay loop and reloads the API workload token from a mounted secret on use. The API token must map to an authorized service identity with tenant/factory scope and ot.telemetry.ingest permission. Blocked events require operator inspection and the exact durable event fingerprint before manual requeue; retry and acknowledgement failures are never silently discarded.

## Reconnect/recovery sequence

1. Edge gateway consumes MQTT with QoS 1; normalize the event and enqueue it durably before acknowledging the broker.
2. When API reachability is restored, group queued events by registered tenant/factory/device; deliver batches of at most 20 using the same source IDs, sequences, timestamps and payloads.
3. For every response, validate one result per source ID. Remove entries only for ON_TIME, LATE, SEQUENCE_GAP or DUPLICATE_REPLAY; on timeout/network/schema mismatch persist the attempt count and schedule capped exponential backoff.
4. Reconnect must not reset source sequence or mint a new event ID for an old message. A conflicting ID, unexpected acknowledgement, spool authentication failure, retry-exhausted blocked record or queue-full state requires an operations/dead-letter alert; never silently discard the record.
5. During rollout, test power loss at enqueue/fsync/rename, API outage, response loss after DB commit, same-batch and partial replay, duplicate MQTT delivery, sequence gap/late sample, full disk, wrong encryption key, restored gateway and isolated tenant/factory. Capture site/operator evidence before commissioning.

## CI and remaining field acceptance

Automated code tests cover MQTT topic/profile enforcement, payload bounds, Modbus register map and word decoding, gateway URL/TLS/redirect/timeout and response validation, spool encryption and recovery, duplicate fingerprints, bounded backoff, cross-device progress and failure retention. Migration 158 adds explicit ot.mqtt.ingest and ot.modbus.read permissions and extends append-only history with MODBUS_READ_COMPLETED/MODBUS_READ_FAILED; PostgreSQL CI applies and reapplies the migration and checks permission/role/history contracts.

## Deployable gateway and field acceptance

The standalone executable now lives in edge/ot-gateway. Its MQTT.js client maintains a persistent QoS 1 broker session and writes each event to the AES-256-GCM spool before allowing MQTT.js to acknowledge the delivery. The OPC UA driver uses a secure client session with certificate trust, subscriptions and bounded polling/reconnect. The Modbus TCP driver opens real TCP sockets for the approved function-code 3/4 register map only; the authenticated HTTPS API adapter accepts the scope and exact register selection but never accepts a destination host or write operation from request JSON.

The container build is edge/ot-gateway/Dockerfile. The reference restricted Deployment/PVC/Service and NetworkPolicy are in edge/ot-gateway/deploy/deployment.yaml and edge/ot-gateway/deploy/network-policy.yaml. The gateway configuration example lists exact approved target endpoints and mounted secret paths. Operators must replace every sample host, CIDR, identity, certificate and register map with site-approved values. MQTT broker ACLs and the actual plant firewall/VLAN are separate controls and must be applied by the infrastructure/OT teams.

Automated fault-injection tests and a local Modbus TCP socket simulator live in edge/ot-gateway/test/gateway.faults.test.mjs and edge/ot-gateway/test/modbus-tcp-simulator.mjs. The new OT Gateway CI workflow installs the pinned direct protocol libraries, checks JS syntax, runs the fault suite, and builds the container. It tests local software behavior; it does not prove a live broker or PLC has been commissioned.

**Still not claimed:** this repository change does not provision customer PKI/secret-manager infrastructure, broker accounts/ACLs, switch/firewall rules or PLC configuration, and does not include signed hardware-in-the-loop acceptance evidence. A hardware commissioning record must be completed at the site by an authorized OT operator using edge/ot-gateway/deploy/commissioning-evidence.template.md. Read-only gateway functions must not be interpreted as a PLC write capability.
