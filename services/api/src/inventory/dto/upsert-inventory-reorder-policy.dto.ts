import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpsertInventoryReorderPolicyDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99999999999999)
  minimum_quantity!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99999999999999)
  maximum_quantity!: number;

  @IsInt()
  @Min(0)
  @Max(3650)
  lead_time_days!: number;

  @IsOptional()
  @IsUUID()
  preferred_supplier_id?: string | null;

  @IsBoolean()
  enabled!: boolean;
}
