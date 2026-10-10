import { IsString, MaxLength } from 'class-validator';

/**
 * Accepts explicitly supplied plain text only. Binary formats, URLs, and
 * client-supplied parser/security statuses are intentionally not accepted.
 */
export class IngestResearchSourceTextDto {
  @IsString()
  @MaxLength(32768)
  content!: string;
}
