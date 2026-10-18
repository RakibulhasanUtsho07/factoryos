import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, Length } from 'class-validator';
export class CreateProductDto {
  @IsUUID() inventory_item_id!: string;
  @IsString() @IsNotEmpty() @Length(1, 120) product_code!: string;
  @IsString() @IsNotEmpty() @Length(1, 255) product_name!: string;
  @IsOptional() @IsIn(['STANDARD','CONFIGURABLE','PHANTOM','KIT']) product_type?: 'STANDARD'|'CONFIGURABLE'|'PHANTOM'|'KIT';
  @IsString() @IsNotEmpty() @Length(1, 50) base_unit!: string;
}
