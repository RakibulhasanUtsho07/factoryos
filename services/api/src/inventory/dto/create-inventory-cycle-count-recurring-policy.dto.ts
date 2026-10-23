import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateInventoryCycleCountRecurringPolicyDto {
  @IsUUID()
  item_id!: string;

  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsUUID()
  assigned_to_user_id!: string;

  @IsIn(['DAILY', 'WEEKLY', 'MONTHLY'])
  cadence_unit!: 'DAILY' | 'WEEKLY' | 'MONTHLY';

  /** Number of days, weeks or months between occurrences. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  cadence_interval?: number;

  /** Timestamp of the first calendar occurrence; subsequent dates stay anchored to this instant. */
  @IsDateString()
  first_run_at!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  blind_count?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false })
  @Min(0.0001)
  @Max(99999999999999)
  variance_escalation_threshold?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
