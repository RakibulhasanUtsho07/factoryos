import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export enum InventoryMovementType {
  RECEIPT = 'RECEIPT',
  ISSUE = 'ISSUE',
  ADJUSTMENT = 'ADJUSTMENT',
}

export class CreateInventoryItemDto {
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/)
  item_code!: string;

  @IsString()
  @MaxLength(240)
  @Matches(/.*\S.*/)
  item_name!: string;

  @IsString()
  @MaxLength(24)
  @Matches(/^[A-Za-z][A-Za-z0-9._-]{0,23}$/)
  base_unit!: string;
}

export class ListInventoryItemsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class CreateInventoryMovementDto {
  @IsUUID()
  item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  location_code!: string;

  @IsEnum(InventoryMovementType)
  movement_type!: InventoryMovementType;

  // Signed quantity: receipt positive, issue negative, adjustment either way.
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-1000000000000)
  @Max(1000000000000)
  quantity_delta!: number;

  @IsString()
  @MaxLength(300)
  @Matches(/^.{8,300}$/)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference_ref?: string;
}


export enum InventoryReservationStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
  CONSUMED = 'CONSUMED',
}

export class CreateInventoryReservationDto {
  @IsUUID()
  item_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  location_code!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  @Max(1000000000000)
  quantity!: number;

  @IsString()
  @MaxLength(300)
  @Matches(/^.{8,300}$/)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference_ref?: string;
}

export class TransitionInventoryReservationDto {
  @IsString()
  @MaxLength(300)
  @Matches(/^.{8,300}$/)
  reason!: string;
}

export class ListInventoryReservationsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsUUID()
  item_id?: string;

  @IsOptional()
  @IsEnum(InventoryReservationStatus)
  status?: InventoryReservationStatus;
}

export class ListInventoryBalancesDto {
  @IsOptional()
  @IsUUID()
  item_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  location_code?: string;
}

export class ListInventoryMovementsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsUUID()
  item_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)
  location_code?: string;

  @IsOptional()
  @IsEnum(InventoryMovementType)
  movement_type?: InventoryMovementType;
}
