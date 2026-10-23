import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateInventoryCycleCountTaskDto {
  @IsUUID()
  item_id!: string;

  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  assigned_to_user_id?: string;

  @IsDateString()
  due_at!: string;

  /** Smaller numbers are scheduled first. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  priority?: number;

  /** New tasks default to blind counting; the counter never receives the expected snapshot. */
  @IsOptional()
  @IsBoolean()
  blind_count?: boolean;

  /** Positive absolute quantity variance that requires independent review before stock can change. */
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
