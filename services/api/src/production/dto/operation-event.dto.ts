import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const OPERATION_COMMANDS = [
  'START', 'PAUSE', 'RESUME', 'HOLD', 'COMPLETE', 'SKIP',
  'DOWNTIME_START', 'DOWNTIME_END', 'WIP_REPORTED', 'WIP_TRANSFERRED', 'REWORK_REPORTED',
] as const;

export class OperationEventDto {
  @IsIn(OPERATION_COMMANDS)
  command!: (typeof OPERATION_COMMANDS)[number];

  @IsInt()
  @Min(1)
  expected_work_order_version!: number;

  @IsInt()
  @Min(1)
  expected_operation_version!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsUUID()
  target_operation_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsIn(['API', 'HMI', 'MES', 'PLC', 'MOBILE', 'IMPORT'])
  source?: 'API' | 'HMI' | 'MES' | 'PLC' | 'MOBILE' | 'IMPORT';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  device_id?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  occurred_at?: string;
}
