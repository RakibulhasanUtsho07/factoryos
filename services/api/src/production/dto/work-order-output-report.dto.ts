import { IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, MaxLength, Min } from 'class-validator';

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
  @Matches(/^(?=.*\S)[^\x00-\x1F\x7F-\x9F]{1,160}$/)
  @MaxLength(160)
  finished_good_serial_code?: string;

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
