import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class LogMachineDowntimeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  reason_code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
