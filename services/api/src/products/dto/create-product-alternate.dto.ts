import { IsInt, IsNotEmpty, IsNumber, IsString, IsUUID, Length, Max, Min } from 'class-validator';
export class CreateProductAlternateDto {
  @IsInt() @Min(1) expected_version!: number;
  @IsUUID() alternate_item_id!: string;
  @IsNumber({ maxDecimalPlaces: 6 }) @Min(0.000001) @Max(999999999999) conversion_factor!: number;
  @IsString() @IsNotEmpty() @Length(1, 50) unit!: string;
  @IsString() @IsNotEmpty() @Length(1, 2000) rationale!: string;
}
