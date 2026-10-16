import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateOrderProductionReportDto {
  @IsUUID()
  order_line_id!: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  good_quantity!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  scrap_quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  scrap_reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
