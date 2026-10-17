import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class UpdateInventoryLocationPolicyDto {
  @IsOptional()
  @IsBoolean()
  putaway_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  picking_enabled?: boolean;

  /** Smaller numbers are preferred first by directed put-away. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  putaway_priority?: number;

  /** Smaller numbers are preferred first by directed picking. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  picking_priority?: number;
}
