import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';
export class ProductBomLineInputDto {
  @IsInt() @Min(1) line_number!: number;
  @IsUUID() component_item_id!: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(99999999999999) quantity_per!: number;
  @IsString() @IsNotEmpty() @Length(1, 50) unit!: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) wastage_percent?: number;
  @IsOptional() @IsString() @Length(1, 100) alternate_group_code?: string | null;
  @IsOptional() @IsString() @Length(0, 2000) notes?: string | null;
}
export class ReplaceProductBomDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ProductBomLineInputDto)
  lines!: ProductBomLineInputDto[];
}
