import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export const ORDER_MATERIAL_DISPOSITION_TYPES = [
  'RETURN_TO_STOCK',
  'SCRAPPED',
] as const;

export type OrderMaterialDispositionType =
  (typeof ORDER_MATERIAL_DISPOSITION_TYPES)[number];

export class CreateOrderMaterialDispositionDto {
  @IsUUID()
  reservation_id!: string;

  @IsIn(ORDER_MATERIAL_DISPOSITION_TYPES)
  disposition_type!: OrderMaterialDispositionType;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
