import {
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CancelInventoryCycleCountTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  cancellation_reason!: string;
}
