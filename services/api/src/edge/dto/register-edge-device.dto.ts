import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export enum EdgeDeviceProtocol {
  OPC_UA = 'OPC_UA',
  MQTT = 'MQTT',
  MODBUS = 'MODBUS',
  GENERIC = 'GENERIC',
}

export class RegisterEdgeDeviceDto {
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  device_key!: string;

  @IsString()
  @MaxLength(180)
  display_name!: string;

  @IsEnum(EdgeDeviceProtocol)
  protocol!: EdgeDeviceProtocol;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/)
  device_group?: string;

  @IsOptional()
  @IsObject()
  capability_profile?: Record<string, unknown>;
}
