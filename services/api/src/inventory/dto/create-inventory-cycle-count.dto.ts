import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateInventoryCycleCountDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99999999999999)
  counted_quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  variance_reason?: string;
}
