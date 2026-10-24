# FactoryOS OT Gateway — Simulator and Hardware-in-the-Loop Commissioning Record

> This is a blank evidence template. Do not mark any result PASS until the actual simulator or site test has run and its artifact has been attached. Hardware commissioning requires an authorized OT operator.

## Record identity

| Field | Recorded value |
|---|---|
| Change/ticket ID | |
| Factory/site/line | |
| Gateway asset ID and serial | |
| Gateway image digest | |
| Gateway configuration artifact reference (relative to evidence artifact root) | |
| Gateway configuration SHA-256 (must match the referenced file bytes) | |
| API deployment/build SHA | |
| PLC/device/broker model and firmware | |
| Operator and approver | |
| Test date/time and timezone | |
| Approved maintenance window | |
| Rollback/stop-work contact | |

## Security and commissioning preconditions

- [ ] Approved network diagram attached; only reviewed broker/API/OPC UA/Modbus destinations are allowed.
- [ ] Gateway egress policy and firewall ACLs reviewed by OT/security owners.
- [ ] MQTT client certificate, broker CA and exact-topic ACL fingerprints verified.
- [ ] OPC UA server trust chain and client certificate/key pair verified; SignAndEncrypt and Basic256Sha256 confirmed.
- [ ] Modbus unit ID/register map reviewed against the approved meter map; only function 3/4 reads permitted.
- [ ] Gateway/API service identities are scoped to the intended tenant/factory/device; no secret value appears in the evidence bundle.
- [ ] PLC writes/coils/broadcasts are explicitly out of scope and have not been enabled.

## Required simulator/fault-injection evidence

| Case | Expected safe outcome | Artifact/reference | Result (PASS/FAIL) |
|---|---|---|---|
| Wrong spool key | Startup/recovery fails closed; existing encrypted queue remains intact | | |
| Mismatched TLS certificate/private key | Protocol connection rejected; no plaintext fallback | | |
| Gateway crash during enqueue/atomic rename | Prior complete spool recovers; no silent queue reset | | |
| Broker PUBACK lost after durable enqueue | QoS 1 redelivery deduplicates to one source ID | | |
| MQTT broker unavailable / reconnect | Durable queue retained, reconnect resumes without new IDs | | |
| API commits event but acknowledgement is lost | Same IDs are retried; duplicate acknowledgement permits safe removal | | |
| Duplicate source event ID with changed content | Conflict/recovery alert; event not silently overwritten | | |
| Sequence gap (for example source sequence 40 then 42) | Gap is preserved and surfaced by API sequence reconciliation | | |
| Modbus TCP response loss / timeout | Read fails safely, driver reconnects, no write request occurs | | |
| Wrong Modbus unit ID or malformed register response | Read fails closed; no wrong-device value is accepted | | |
| Certificate/key rotation | New valid credential is adopted; failed/mismatched rotation leaves driver unready | | |
| Disk full / queue capacity reached | New event is not acknowledged/dropped; alarm and durable backlog evidence exist | | |
| Cross-tenant/factory scope mismatch | API rejects the request; no endpoint or register-map override is possible | | |

## Operator-approved hardware-in-the-loop tests

Perform only during the approved maintenance window and under the plant's lockout/tagout and change-control procedures.

| Case | Expected safe outcome | Artifact/reference | Result (PASS/FAIL) |
|---|---|---|---|
| OPC UA secure session + subscription read | Only approved NodeIds produce normalized telemetry | | |
| OPC UA poll/session interruption/reconnect | Session recovers; no guessed or unverified value is marked good | | |
| MQTT telemetry and broker restart | Exact topics resume with QoS 1; offline spool reconciles | | |
| Modbus TCP read of approved registers | Register responses match the reviewed unit/address/type map | | |
| PLC/control network read-only verification | No function code, endpoint or route permits PLC writes | | |
| API outage and restore | Spool backlog drains with duplicate/gap statuses reconciled against source IDs | | |
| Gateway power loss and restart | Encrypted spool recovers; queue count and hashes reconcile | | |
| Operator stop/rollback drill | Site's documented stop action and restoration are executed and timed | | |

## Reconciliation and sign-off

| Metric/evidence | Value/reference |
|---|---|
| Events generated / durably spooled | |
| Events acknowledged by API | |
| Duplicate replay outcomes | |
| Sequence gaps / late events | |
| Remaining pending/blocked spool entries | |
| Unresolved alarm/incident IDs | |
| Packet capture / broker log / PLC audit references | |
| Rollback performed (yes/no; change ID) | |

**OT operator decision:** PASS / FAIL / CONDITIONAL

**Conditions or exceptions (do not leave blank for a conditional result):**

**OT operator name/signature/date:**

**FactoryOS release approver/signature/date:**

**Security/network approver/signature/date:**
