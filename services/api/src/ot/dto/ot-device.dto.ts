import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OPC_UA_NODE_ID_PATTERN } from '../ot-device.contract';

export const OT_PROTOCOLS = ['OPC_UA', 'MQTT', 'MODBUS_TCP'] as const;
export type OtProtocol = (typeof OT_PROTOCOLS)[number];

export class RegisterOtDeviceDto {
  @IsString()
  @Length(2, 160)
  display_name!: string;

  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9._:-]{1,159}$/)
  device_key!: string;

  @IsIn(OT_PROTOCOLS)
  protocol!: OtProtocol;

  /** Reference only. The connection secret itself must remain in a secret manager. */
  @IsString()
  @Matches(/^config:\/\/[A-Z0-9][A-Z0-9_./-]{0,119}$/)
  connection_reference!: string;

  @IsString()
  @Matches(/^env:\/\/OT_SECRET_[A-Z][A-Z0-9_]{0,79}$/)
  secret_reference!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ReadOpcUaNodesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Matches(OPC_UA_NODE_ID_PATTERN, { each: true })
  node_ids!: string[];
}

export class IngestMqttMessageDto {
  @IsString()
  @Length(1, 256)
  @Matches(/^[A-Za-z0-9_./:-]+$/)
  topic!: string;

  @IsObject()
  message!: Record<string, unknown>;
}

export class ReadModbusRegistersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 160, { each: true })
  @Matches(/^[A-Z][A-Z0-9_.-]{0,159}$/, { each: true })
  stream_keys!: string[];
}

export class OtDeviceTransitionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class OtTelemetrySampleDto {
  @IsString()
  @Length(1, 200)
  source_event_id!: string;

  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Z][A-Z0-9_.-]{0,99}$/)
  event_type!: string;

  @IsString()
  @Length(1, 160)
  stream_key!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(9007199254740991)
  source_sequence?: number;

  @IsDateString()
  observed_at!: string;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class IngestOtTelemetryBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OtTelemetrySampleDto)
  events!: OtTelemetrySampleDto[];
}
