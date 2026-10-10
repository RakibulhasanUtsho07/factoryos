import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const MAINTENANCE_MACHINE_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'RETIRED',
] as const;

export type MaintenanceMachineStatus =
  (typeof MAINTENANCE_MACHINE_STATUSES)[number];

export class CreateMachineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  machine_code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  machine_type!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  line_code!: string;

  @IsOptional()
  @IsIn([...MAINTENANCE_MACHINE_STATUSES])
  status?: MaintenanceMachineStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
