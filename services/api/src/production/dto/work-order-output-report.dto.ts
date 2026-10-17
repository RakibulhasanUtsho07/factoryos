import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class WorkOrderOutputReportDto {
  @IsUUID()
  operation_id!: string;

  @IsInt()
  @Min(1)
  expected_work_order_version!: number;

  @IsInt()
  @Min(1)
  expected_operation_version!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  good_quantity!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  scrap_quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  scrap_reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

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
