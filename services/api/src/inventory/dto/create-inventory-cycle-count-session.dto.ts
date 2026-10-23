import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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
} from 'class-validator';

export class CreateInventoryCycleCountSessionDto {
  @IsUUID()
  item_id!: string;

  /** One physical count session covers 2–50 distinct active bins for the same item. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  location_ids!: string[];

  /** All bins in a session are assigned to one active tenant member. */
  @IsUUID()
  assigned_to_user_id!: string;

  @IsDateString()
  due_at!: string;

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
