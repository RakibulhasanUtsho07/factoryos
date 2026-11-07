import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import { SupplierPerformanceQueryDto } from './dto/supplier-performance-query.dto';

export interface SupplierPerformanceReport extends Record<string, unknown> {
  supplier: { id: string; code: string; name: string } | null;
}
interface SupplierPerformanceRow extends QueryResultRow {
  report: SupplierPerformanceReport | null;
}
function parseCalendarDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(field + ' must be an ISO calendar date in YYYY-MM-DD form');
  }
  const parsed = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) {
    throw new BadRequestException(field + ' must be a real calendar date');
  }
  return value;
}

@Injectable()
export class SupplierPerformanceService {
  constructor(private readonly database: DatabaseService) {}

  async getSupplierPerformance(
    tenantId: string, factoryId: string, supplierId: string, query: SupplierPerformanceQueryDto,
  ): Promise<SupplierPerformanceReport> {
    if (!isUUID(tenantId) || !isUUID(factoryId) || !isUUID(supplierId)) {
      throw new BadRequestException('Supplier performance scope must contain valid tenant, factory and supplier UUIDs');
    }
    const from = parseCalendarDate(query.from,'from');
    const to = parseCalendarDate(query.to,'to');
    const asOf = query.as_of === undefined ? null : parseCalendarDate(query.as_of,'as_of');
    const daySpan = (Date.parse(to+'T00:00:00.000Z')-Date.parse(from+'T00:00:00.000Z'))/86400000;
    if (daySpan < 0) throw new BadRequestException('from must be on or before to');
    if (daySpan > 365) throw new BadRequestException('Supplier performance date range cannot exceed 366 inclusive calendar days');

    const result = await this.database.query<SupplierPerformanceRow>(
      'SELECT public.factoryos_supplier_performance_report($1::uuid,$2::uuid,$3::date,$4::date,$5::date) AS report',
      [factoryId,supplierId,from,to,asOf],{tenantId,readOnly:true},
    );
    const report = result.rows[0]?.report;
    if (!report || report.supplier === null) throw new NotFoundException('Supplier was not found in the authenticated tenant');
    return report;
  }
}
