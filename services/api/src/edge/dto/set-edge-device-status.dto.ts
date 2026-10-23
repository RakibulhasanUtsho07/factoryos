import { IsEnum } from 'class-validator';

export enum EdgeDeviceStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  REVOKED = 'REVOKED',
}

export class SetEdgeDeviceStatusDto {
  @IsEnum(EdgeDeviceStatus)
  status!: EdgeDeviceStatus;
}
