import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ExecuteAiActionDto {
  @IsString()
  @MaxLength(255)
  action_token!: string;

  @IsString()
  @MaxLength(255)
  execution_key!: string;

  @IsString()
  @MaxLength(100)
  tool_version!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  executor_type?: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
