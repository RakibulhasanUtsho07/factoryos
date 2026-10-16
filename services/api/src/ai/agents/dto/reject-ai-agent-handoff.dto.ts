import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class RejectAiAgentHandoffDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
